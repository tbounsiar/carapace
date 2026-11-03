//! In-memory SFTP subsystem for the test server. Behaves like OpenSSH's sftp-server where the
//! client code depends on it: generic failure for existing targets and non-empty directories,
//! `readdir` in pages with `.` and `..`, `lstat` never follows links, `O_EXCL` opens fail on
//! any existing entry, `posix-rename@openssh.com` replaces its target (unless turned off).
//! Permission bits given at create, mkdir or `fsetstat` are kept per path.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Packet, Status, StatusCode, Version,
};

pub const HOME: &str = "/home/me";
const PAGE: usize = 100;

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Dir {
        denied: bool,
    },
    /// A file of that many zero bytes.
    File(u64),
    Data(Vec<u8>),
    Link(String),
}

#[derive(Clone)]
pub struct MemFs(
    pub Arc<Mutex<BTreeMap<String, Node>>>,
    /// When set, `readdir` reports symlinks as directories, like a racing or hostile server.
    pub Arc<std::sync::atomic::AtomicBool>,
    /// Milliseconds every file read and write waits, to keep transfers in flight.
    pub Arc<AtomicU64>,
    pub Arc<Mutex<Extra>>,
);

#[derive(Default)]
pub struct Extra {
    /// Permission bits (`0o7777`) set on a path; others use the defaults of `attrs`.
    pub modes: HashMap<String, u32>,
    /// Hide `posix-rename@openssh.com` from sessions opened from now on.
    pub no_posix_rename: bool,
    /// Names readdir adds to every listing, to play a hostile server.
    pub extra_names: Vec<String>,
}

impl Default for MemFs {
    fn default() -> Self {
        let fs = Self(
            Default::default(),
            Default::default(),
            Default::default(),
            Default::default(),
        );
        for d in ["/", "/home", HOME] {
            fs.dir(d);
        }
        fs.file(&format!("{HOME}/.profile"), 12);
        fs
    }
}

fn parent(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => path[..i].into(),
    }
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

impl MemFs {
    pub fn dir(&self, path: &str) {
        self.insert(path, Node::Dir { denied: false });
    }
    pub fn denied_dir(&self, path: &str) {
        self.insert(path, Node::Dir { denied: true });
    }
    pub fn file(&self, path: &str, size: u64) {
        self.insert(path, Node::File(size));
    }
    pub fn data(&self, path: &str, bytes: Vec<u8>) {
        self.insert(path, Node::Data(bytes));
    }
    pub fn contents(&self, path: &str) -> Option<Vec<u8>> {
        match self.get(path)? {
            Node::Data(d) => Some(d),
            Node::File(n) => Some(vec![0; n as usize]),
            _ => None,
        }
    }
    pub fn set_delay(&self, ms: u64) {
        self.2.store(ms, Ordering::SeqCst);
    }
    pub fn mode(&self, path: &str) -> Option<u32> {
        self.3.lock().unwrap().modes.get(path).copied()
    }
    pub fn set_mode(&self, path: &str, mode: u32) {
        self.3
            .lock()
            .unwrap()
            .modes
            .insert(path.into(), mode & 0o7777);
    }
    pub fn set_posix_rename(&self, on: bool) {
        self.3.lock().unwrap().no_posix_rename = !on;
    }
    pub fn add_listed_name(&self, name: String) {
        self.3.lock().unwrap().extra_names.push(name);
    }
    fn attrs_at(&self, path: &str, node: &Node) -> FileAttributes {
        let mut a = attrs(node);
        if let (Some(m), Some(p)) = (self.mode(path), a.permissions) {
            a.permissions = Some((p & !0o7777) | m);
        }
        a
    }
    fn move_modes(&self, old: &str, new: &str) {
        let mut extra = self.3.lock().unwrap();
        let prefix = format!("{old}/");
        let moved: Vec<String> = extra
            .modes
            .keys()
            .filter(|k| *k == old || k.starts_with(&prefix))
            .cloned()
            .collect();
        for k in moved {
            let m = extra.modes.remove(&k).unwrap();
            extra.modes.insert(format!("{new}{}", &k[old.len()..]), m);
        }
    }
    fn forget_mode(&self, path: &str) {
        self.3.lock().unwrap().modes.remove(path);
    }
    /// Paths under `dir` (recursively), sorted.
    pub fn paths_under(&self, dir: &str) -> Vec<String> {
        let prefix = format!("{dir}/");
        self.0
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect()
    }
    pub fn link(&self, path: &str, target: &str) {
        self.insert(path, Node::Link(target.into()));
    }
    pub fn get(&self, path: &str) -> Option<Node> {
        self.0.lock().unwrap().get(path).cloned()
    }
    fn insert(&self, path: &str, node: Node) {
        self.0.lock().unwrap().insert(path.into(), node);
    }

    fn children(map: &BTreeMap<String, Node>, dir: &str) -> Vec<String> {
        let prefix = if dir == "/" {
            "/".to_string()
        } else {
            format!("{dir}/")
        };
        map.range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .filter(|(k, _)| k.len() > prefix.len() && !k[prefix.len()..].contains('/'))
            .map(|(k, _)| k.clone())
            .collect()
    }

    fn absolute(path: &str) -> String {
        let full = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("{HOME}/{path}")
        };
        let mut parts: Vec<&str> = Vec::new();
        for p in full.split('/') {
            match p {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                p => parts.push(p),
            }
        }
        format!("/{}", parts.join("/"))
    }

    fn resolve(&self, path: &str) -> String {
        let mut p = Self::absolute(path);
        for _ in 0..8 {
            match self.get(&p) {
                Some(Node::Link(t)) => p = Self::absolute(&t),
                _ => break,
            }
        }
        p
    }
}

fn attrs(node: &Node) -> FileAttributes {
    let (mode, size) = match node {
        Node::Dir { .. } => (0o040755, 4096),
        Node::File(s) => (0o100644, *s),
        Node::Data(d) => (0o100644, d.len() as u64),
        Node::Link(t) => (0o120777, t.len() as u64),
    };
    FileAttributes {
        size: Some(size),
        permissions: Some(mode),
        mtime: Some(1_700_000_000),
        atime: Some(1_700_000_000),
        ..Default::default()
    }
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en-US".into(),
    }
}

pub struct MemSftp {
    pub fs: MemFs,
    handles: HashMap<String, Vec<File>>,
    files: HashMap<String, String>,
    next: u64,
}

impl MemSftp {
    pub fn new(fs: MemFs) -> Self {
        Self {
            fs,
            handles: HashMap::new(),
            files: HashMap::new(),
            next: 0,
        }
    }

    fn node(&self, path: &str) -> Result<Node, StatusCode> {
        self.fs.get(path).ok_or(StatusCode::NoSuchFile)
    }

    async fn pause(&self) {
        let ms = self.fs.2.load(Ordering::SeqCst);
        if ms > 0 {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }

    fn file_path(&self, handle: &str) -> Result<String, StatusCode> {
        self.files.get(handle).cloned().ok_or(StatusCode::Failure)
    }

    fn handle(&mut self) -> String {
        self.next += 1;
        format!("h{}", self.next)
    }
}

fn decode_string(data: &[u8]) -> Option<(String, &[u8])> {
    let len = u32::from_be_bytes(data.get(..4)?.try_into().ok()?) as usize;
    let s = String::from_utf8(data.get(4..4 + len)?.to_vec()).ok()?;
    Some((s, &data[4 + len..]))
}

impl russh_sftp::server::Handler for MemSftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        let mut version = Version::new();
        if !self.fs.3.lock().unwrap().no_posix_rename {
            version
                .extensions
                .insert("posix-rename@openssh.com".into(), "1".into());
        }
        Ok(version)
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = if pflags.contains(OpenFlags::EXCLUDE) {
            let path = MemFs::absolute(&filename);
            if self.fs.get(&path).is_some() {
                return Err(StatusCode::Failure);
            }
            match self.node(&parent(&path))? {
                Node::Dir { denied: false } => {}
                Node::Dir { denied: true } => return Err(StatusCode::PermissionDenied),
                _ => return Err(StatusCode::Failure),
            }
            self.fs.data(&path, Vec::new());
            match attrs.permissions {
                Some(m) => self.fs.set_mode(&path, m),
                None => self.fs.forget_mode(&path),
            }
            path
        } else {
            let path = self.fs.resolve(&filename);
            match self.node(&path)? {
                Node::File(_) | Node::Data(_) => path,
                _ => return Err(StatusCode::Failure),
            }
        };
        let handle = self.handle();
        self.files.insert(handle.clone(), path);
        Ok(Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        self.pause().await;
        let path = self.file_path(&handle)?;
        let data = self.fs.contents(&path).ok_or(StatusCode::Failure)?;
        let start = usize::try_from(offset).map_err(|_| StatusCode::Eof)?;
        if start >= data.len() {
            return Err(StatusCode::Eof);
        }
        let end = data.len().min(start + len as usize);
        Ok(Data {
            id,
            data: data[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        self.pause().await;
        let path = self.file_path(&handle)?;
        let mut map = self.fs.0.lock().unwrap();
        let Some(Node::Data(bytes)) = map.get_mut(&path) else {
            return Err(StatusCode::Failure);
        };
        let start = offset as usize;
        if bytes.len() < start + data.len() {
            bytes.resize(start + data.len(), 0);
        }
        bytes[start..start + data.len()].copy_from_slice(&data);
        Ok(ok(id))
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let path = self.file_path(&handle)?;
        let node = self.node(&path)?;
        Ok(Attrs {
            id,
            attrs: self.fs.attrs_at(&path, &node),
        })
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let path = self.file_path(&handle)?;
        if let Some(m) = attrs.permissions {
            self.fs.set_mode(&path, m);
        }
        Ok(ok(id))
    }

    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        if request != "posix-rename@openssh.com" {
            return Err(StatusCode::OpUnsupported);
        }
        let (old, rest) = decode_string(&data).ok_or(StatusCode::BadMessage)?;
        let (new, _) = decode_string(rest).ok_or(StatusCode::BadMessage)?;
        let (old, new) = (MemFs::absolute(&old), MemFs::absolute(&new));
        let mut map = self.fs.0.lock().unwrap();
        let node = map.get(&old).cloned().ok_or(StatusCode::NoSuchFile)?;
        if matches!(map.get(&new), Some(Node::Dir { .. })) || matches!(node, Node::Dir { .. }) {
            return Err(StatusCode::Failure);
        }
        map.remove(&old);
        map.insert(new.clone(), node);
        drop(map);
        self.fs.forget_mode(&new);
        self.fs.move_modes(&old, &new);
        Ok(Packet::Status(ok(id)))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let real = self.fs.resolve(&path);
        self.node(&real)?;
        Ok(Name {
            id,
            files: vec![File::dummy(real)],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let real = self.fs.resolve(&path);
        match self.node(&real)? {
            Node::Dir { denied: true } => return Err(StatusCode::PermissionDenied),
            Node::Dir { .. } => {}
            _ => return Err(StatusCode::Failure),
        }
        let lie = self.fs.1.load(std::sync::atomic::Ordering::SeqCst);
        let map = self.fs.0.lock().unwrap();
        let mut files = vec![
            File::new(".", attrs(&Node::Dir { denied: false })),
            File::new("..", attrs(&Node::Dir { denied: false })),
        ];
        let children: Vec<(String, Node)> = MemFs::children(&map, &real)
            .into_iter()
            .map(|c| {
                let node = map[&c].clone();
                (c, node)
            })
            .collect();
        drop(map);
        for (child, node) in children {
            let node = match node {
                Node::Link(_) if lie => Node::Dir { denied: false },
                n => n,
            };
            files.push(File::new(name_of(&child), self.fs.attrs_at(&child, &node)));
        }
        for name in &self.fs.3.lock().unwrap().extra_names {
            files.push(File::new(name, attrs(&Node::File(1))));
        }
        let handle = self.handle();
        self.handles.insert(handle.clone(), files);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let files = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        let page: Vec<File> = files.drain(..files.len().min(PAGE)).collect();
        Ok(Name { id, files: page })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        self.files.remove(&handle);
        Ok(ok(id))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let path = MemFs::absolute(&path);
        let node = self.node(&path)?;
        Ok(Attrs {
            id,
            attrs: self.fs.attrs_at(&path, &node),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let path = self.fs.resolve(&path);
        let node = self.node(&path)?;
        Ok(Attrs {
            id,
            attrs: self.fs.attrs_at(&path, &node),
        })
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let path = MemFs::absolute(&path);
        if self.fs.get(&path).is_some() {
            return Err(StatusCode::Failure);
        }
        match self.node(&parent(&path))? {
            Node::Dir { denied: false } => {}
            Node::Dir { denied: true } => return Err(StatusCode::PermissionDenied),
            _ => return Err(StatusCode::Failure),
        }
        self.fs.dir(&path);
        match attrs.permissions {
            Some(m) => self.fs.set_mode(&path, m),
            None => self.fs.forget_mode(&path),
        }
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let path = MemFs::absolute(&path);
        let mut map = self.fs.0.lock().unwrap();
        match map.get(&path) {
            None => return Err(StatusCode::NoSuchFile),
            Some(Node::Dir { .. }) => {}
            Some(_) => return Err(StatusCode::Failure),
        }
        if !MemFs::children(&map, &path).is_empty() {
            return Err(StatusCode::Failure);
        }
        map.remove(&path);
        Ok(ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let path = MemFs::absolute(&filename);
        let mut map = self.fs.0.lock().unwrap();
        match map.get(&path) {
            None => Err(StatusCode::NoSuchFile),
            Some(Node::Dir { .. }) => Err(StatusCode::Failure),
            Some(_) => {
                map.remove(&path);
                self.fs.forget_mode(&path);
                Ok(ok(id))
            }
        }
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let (old, new) = (MemFs::absolute(&oldpath), MemFs::absolute(&newpath));
        let mut map = self.fs.0.lock().unwrap();
        if !map.contains_key(&old) {
            return Err(StatusCode::NoSuchFile);
        }
        if map.contains_key(&new) {
            return Err(StatusCode::Failure);
        }
        let prefix = format!("{old}/");
        let moved: Vec<String> = map
            .keys()
            .filter(|k| **k == old || k.starts_with(&prefix))
            .cloned()
            .collect();
        for k in moved {
            let node = map.remove(&k).unwrap();
            map.insert(format!("{new}{}", &k[old.len()..]), node);
        }
        drop(map);
        self.fs.move_modes(&old, &new);
        Ok(ok(id))
    }
}
