//! In-memory SFTP subsystem for the test server. Behaves like OpenSSH's sftp-server where the
//! client code depends on it: generic failure for existing targets and non-empty directories,
//! `readdir` in pages with `.` and `..`, `lstat` never follows links.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use russh_sftp::protocol::{
    Attrs, File, FileAttributes, Handle, Name, Status, StatusCode, Version,
};

pub const HOME: &str = "/home/me";
const PAGE: usize = 100;

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Dir { denied: bool },
    File(u64),
    Link(String),
}

#[derive(Clone)]
pub struct MemFs(
    pub Arc<Mutex<BTreeMap<String, Node>>>,
    /// When set, `readdir` reports symlinks as directories, like a racing or hostile server.
    pub Arc<std::sync::atomic::AtomicBool>,
);

impl Default for MemFs {
    fn default() -> Self {
        let fs = Self(Default::default(), Default::default());
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
    next: u64,
}

impl MemSftp {
    pub fn new(fs: MemFs) -> Self {
        Self {
            fs,
            handles: HashMap::new(),
            next: 0,
        }
    }

    fn node(&self, path: &str) -> Result<Node, StatusCode> {
        self.fs.get(path).ok_or(StatusCode::NoSuchFile)
    }
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
        Ok(Version::new())
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
        for child in MemFs::children(&map, &real) {
            let node = match &map[&child] {
                Node::Link(_) if lie => Node::Dir { denied: false },
                n => n.clone(),
            };
            files.push(File::new(name_of(&child), attrs(&node)));
        }
        drop(map);
        self.next += 1;
        let handle = format!("h{}", self.next);
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
        Ok(ok(id))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let node = self.node(&MemFs::absolute(&path))?;
        Ok(Attrs {
            id,
            attrs: attrs(&node),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let node = self.node(&self.fs.resolve(&path))?;
        Ok(Attrs {
            id,
            attrs: attrs(&node),
        })
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
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
        Ok(ok(id))
    }
}
