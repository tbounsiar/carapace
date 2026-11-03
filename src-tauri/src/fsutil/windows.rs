//! Owner-only security descriptors: a protected DACL with one ACE granting the current user
//! full control. Given at creation through `SECURITY_ATTRIBUTES`, so there is no moment where
//! the object carries the inherited ACL of its directory.

use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    EqualSid, GetAce, GetAclInformation, GetTokenInformation, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain([0]).collect()
}

struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: the handle came from OpenProcessToken and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The `TOKEN_USER` buffer of the current process; the SID points into it.
pub(super) struct UserSid(Vec<u64>);

impl UserSid {
    pub(super) fn current() -> io::Result<Self> {
        let mut raw: HANDLE = ptr::null_mut();
        // SAFETY: the pseudo handle of the current process is always valid; `raw` is writable.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Token(raw);
        let mut len = 0u32;
        // SAFETY: a null buffer of length 0 only asks for the needed size.
        unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        // u64 elements keep the buffer aligned for TOKEN_USER.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: `buf` holds at least `len` writable bytes.
        let ok = unsafe {
            GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), len, &mut len)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(buf))
    }

    pub(super) fn psid(&self) -> *mut core::ffi::c_void {
        // SAFETY: the buffer was filled by GetTokenInformation(TokenUser).
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    fn to_string(&self) -> io::Result<String> {
        sid_string(self.psid())
    }
}

struct Descriptor(PSECURITY_DESCRIPTOR);

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.0) };
    }
}

/// The owner is set to the user explicitly: an elevated process would otherwise make the
/// Administrators group the owner. `P` protects the DACL from inheritance; `OICI` makes
/// children of a directory inherit it.
fn owner_only(directory: bool) -> io::Result<Descriptor> {
    let flags = if directory { "OICI" } else { "" };
    descriptor(&format!("D:P(A;{flags};FA;;;%ME%)"))
}

/// `%ME%` in `dacl` stands for the current user's SID.
fn descriptor(dacl: &str) -> io::Result<Descriptor> {
    let sid = UserSid::current()?.to_string()?;
    let sddl: Vec<u16> = format!("O:{sid}{}", dacl.replace("%ME%", &sid))
        .encode_utf16()
        .chain([0])
        .collect();
    let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated; `sd` receives a LocalAlloc'd descriptor.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Descriptor(sd))
}

fn attributes(sd: &Descriptor) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    }
}

pub fn create_owner_only(path: &Path) -> io::Result<File> {
    create_with(path, &owner_only(false)?)
}

#[cfg(test)]
pub(crate) fn create_dir_with_sddl(path: &Path, dacl: &str) -> io::Result<()> {
    let sd = descriptor(dacl)?;
    let sa = attributes(&sd);
    let name = wide(path);
    // SAFETY: `name` is NUL-terminated and `sa`/`sd` outlive the call.
    if unsafe { CreateDirectoryW(name.as_ptr(), &sa) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn create_with_sddl(path: &Path, dacl: &str) -> io::Result<File> {
    create_with(path, &descriptor(dacl)?)
}

fn create_with(path: &Path, sd: &Descriptor) -> io::Result<File> {
    let sa = attributes(sd);
    let name = wide(path);
    // SAFETY: `name` is NUL-terminated and `sa`/`sd` outlive the call. CREATE_NEW never opens
    // or follows an existing entry.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            &sa,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh, valid handle that nothing else owns.
    Ok(unsafe { File::from_raw_handle(handle) })
}

pub fn create_dir_owner_only(path: &Path) -> io::Result<()> {
    let sd = owner_only(true)?;
    let sa = attributes(&sd);
    let name = wide(path);
    // SAFETY: `name` is NUL-terminated and `sa`/`sd` outlive the call.
    if unsafe { CreateDirectoryW(name.as_ptr(), &sa) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Security information of an open handle; the descriptor is freed on drop.
struct Info {
    sd: PSECURITY_DESCRIPTOR,
    owner: PSID,
    dacl: *mut ACL,
}

impl Drop for Info {
    fn drop(&mut self) {
        // SAFETY: allocated by GetSecurityInfo.
        unsafe { LocalFree(self.sd) };
    }
}

fn security_info(handle: HANDLE, what: u32) -> io::Result<Info> {
    let mut info = Info {
        sd: ptr::null_mut(),
        owner: ptr::null_mut(),
        dacl: ptr::null_mut(),
    };
    // SAFETY: the handle is open; out pointers are writable; `sd` is freed by `Info`.
    let err = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            what,
            &mut info.owner,
            ptr::null_mut(),
            &mut info.dacl,
            ptr::null_mut(),
            &mut info.sd,
        )
    };
    if err != 0 {
        return Err(io::Error::from_raw_os_error(err as i32));
    }
    Ok(info)
}

/// Opens the directory itself (never a link's target) and compares its owner SID.
pub fn owned_by_current_user(dir: &Path) -> io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let handle = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(dir)?;
    let info = security_info(handle.as_raw_handle(), OWNER_SECURITY_INFORMATION)?;
    let user = UserSid::current()?;
    // SAFETY: both SIDs are valid while `info` and `user` live.
    Ok(!info.owner.is_null() && unsafe { EqualSid(info.owner, user.psid()) } != 0)
}

fn sid_string(sid: PSID) -> io::Result<String> {
    let mut out: *mut u16 = ptr::null_mut();
    // SAFETY: `sid` is valid for the call; `out` receives a LocalAlloc'd string.
    if unsafe { ConvertSidToStringSidW(sid, &mut out) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `out` is a NUL-terminated UTF-16 string owned by us until LocalFree.
    let s = unsafe {
        let len = (0..).take_while(|&i| *out.add(i) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(out, len))
    };
    // SAFETY: allocated by ConvertSidToStringSidW.
    unsafe { LocalFree(out.cast()) };
    Ok(s)
}

const FILE_READ_DATA: u32 = 0x1;
const GENERIC_ALL: u32 = 0x1000_0000;

pub fn readable_by_others(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    granted_to_others(
        file.as_raw_handle(),
        FILE_READ_DATA | GENERIC_READ | GENERIC_ALL,
    )
}

/// List (read data), add file, add subdirectory, delete child, delete, change the DACL or
/// the owner, or the generic rights that imply them.
pub fn dir_open_to_others(dir: &Path) -> io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const DIR_RIGHTS: u32 = FILE_READ_DATA | 0x2 | 0x4 | 0x40 | 0x1_0000 | 0x4_0000 | 0x8_0000;
    let handle = std::fs::OpenOptions::new()
        .access_mode(0x0002_0000)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(dir)?;
    granted_to_others(
        handle.as_raw_handle(),
        DIR_RIGHTS | GENERIC_READ | GENERIC_WRITE | GENERIC_ALL,
    )
}

/// Whether an ACCESS_ALLOWED ACE that applies to the object itself grants any of `rights` to
/// a SID other than the current user, SYSTEM and Administrators. Deny ACEs are not weighed.
fn granted_to_others(handle: HANDLE, rights: u32) -> io::Result<bool> {
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    const SYSTEM: &str = "S-1-5-18";
    const ADMINISTRATORS: &str = "S-1-5-32-544";
    let info = security_info(handle, DACL_SECURITY_INFORMATION)?;
    if info.dacl.is_null() {
        return Ok(true);
    }
    let me = UserSid::current()?.to_string()?;
    // SAFETY: an all-zero ACL_SIZE_INFORMATION is valid (plain integers).
    let mut size: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `info.dacl` is a valid ACL while `info` lives; `size` is writable.
    let ok = unsafe {
        GetAclInformation(
            info.dacl,
            (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    for i in 0..size.AceCount {
        let mut ace: *mut core::ffi::c_void = ptr::null_mut();
        // SAFETY: `i` is below the ACE count of a valid ACL.
        if unsafe { GetAce(info.dacl, i, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetAce points at an ACE inside the ACL. Every ACE starts with the header;
        // mask and SID are only used for ACCESS_ALLOWED ACEs, whose layout this is.
        let (kind, flags, mask, sid) = unsafe {
            let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            let sid: PSID = (&ace.SidStart as *const u32).cast_mut().cast();
            (ace.Header.AceType, ace.Header.AceFlags, ace.Mask, sid)
        };
        let applies = kind == ACCESS_ALLOWED_ACE_TYPE && flags & INHERIT_ONLY_ACE == 0;
        if !applies || mask & rights == 0 {
            continue;
        }
        let who = sid_string(sid)?;
        if who != me && who != SYSTEM && who != ADMINISTRATORS {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
pub(super) mod acl {
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use std::ptr;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
        GetSecurityDescriptorControl, INHERITED_ACE, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
    };

    use super::UserSid;

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const FILE_ALL_ACCESS: u32 = 0x001F_01FF;

    /// Whether the DACL is protected and holds exactly one non-inherited ACE granting the
    /// current user full control.
    pub fn is_owner_only(file: &File) -> bool {
        let user = UserSid::current().unwrap();
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: the handle is open; out pointers are writable; `sd` is freed below.
        let err = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut sd,
            )
        };
        assert_eq!(err, 0, "GetSecurityInfo failed");
        // SAFETY: `sd` and `dacl` were returned by GetSecurityInfo and stay valid until freed.
        let result = unsafe {
            let (mut control, mut revision) = (0u16, 0u32);
            assert_ne!(
                GetSecurityDescriptorControl(sd, &mut control, &mut revision),
                0
            );
            let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
            assert_ne!(
                GetAclInformation(
                    dacl,
                    (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                ),
                0
            );
            let mut ace: *mut core::ffi::c_void = ptr::null_mut();
            let single = info.AceCount == 1 && GetAce(dacl, 0, &mut ace) != 0;
            single && {
                let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                let sid = (&ace.SidStart as *const u32).cast_mut().cast();
                control & SE_DACL_PROTECTED != 0
                    && ace.Header.AceType == ACCESS_ALLOWED_ACE_TYPE
                    && u32::from(ace.Header.AceFlags) & INHERITED_ACE == 0
                    && ace.Mask == FILE_ALL_ACCESS
                    && EqualSid(sid, user.psid()) != 0
            }
        };
        // SAFETY: allocated by GetSecurityInfo.
        unsafe { LocalFree(sd) };
        result
    }
}
