use std::{collections::BTreeMap, fs::File, io, mem::{size_of, zeroed}, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle}, ptr::{null, null_mut}};
use windows_sys::Win32::{Foundation::*, Security::SECURITY_ATTRIBUTES, System::{JobObjects::*, Pipes::CreatePipe, Threading::*}};

pub struct Process {
    pub job: OwnedHandle,
    pub root: OwnedHandle,
    pub pid: u32,
    pub creation: String,
    pub stdout: File,
    pub stderr: File,
}
fn check(value: i32) -> io::Result<()> { if value == 0 { Err(io::Error::last_os_error()) } else { Ok(()) } }
fn wide(value: &str) -> io::Result<Vec<u16>> {
    if value.contains('\0') { return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL")); }
    Ok(value.encode_utf16().chain([0]).collect())
}
pub fn quote(value: &str) -> String {
    let mut result = String::from("\""); let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' { slashes += 1; continue; }
        result.extend(std::iter::repeat_n('\\', if c == '"' { slashes * 2 + 1 } else { slashes }));
        result.push(c); slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2)); result.push('"'); result
}
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
        let mut read = null_mut(); let mut write = null_mut();
        check(CreatePipe(&mut read, &mut write, &sa, 0))?;
        Ok((OwnedHandle::from_raw_handle(read), OwnedHandle::from_raw_handle(write)))
    }
}
struct Attributes { _storage: Vec<usize>, list: LPPROC_THREAD_ATTRIBUTE_LIST }
impl Attributes {
    fn new() -> io::Result<Self> {
        unsafe {
            let mut bytes = 0; InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let list = storage.as_mut_ptr().cast(); check(InitializeProcThreadAttributeList(list, 2, 0, &mut bytes))?;
            Ok(Self { _storage: storage, list })
        }
    }
}
impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.list); } } }

pub fn launch(executable: &str, args: &[String], cwd: &str, environment: &BTreeMap<String, String>) -> io::Result<Process> {
    if !std::path::Path::new(executable).is_absolute() || !std::path::Path::new(cwd).is_absolute() || args.len() > 4096 || environment.len() > 4096 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid launch fields"));
    }
    let executable = wide(executable)?; let cwd = wide(cwd)?;
    let mut command = wide(&std::iter::once(String::from_utf16_lossy(&executable[..executable.len()-1])).chain(args.iter().cloned()).map(|v| quote(&v)).collect::<Vec<_>>().join(" "))?;
    if command.len() > 32767 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "command line exceeds Windows limit")); }
    let mut env = Vec::<u16>::new();
    let mut sorted: Vec<_> = environment.iter().collect(); sorted.sort_by_key(|(key, _)| key.to_uppercase());
    for (key, value) in sorted {
        if key.is_empty() || key.contains('=') { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid environment key")); }
        env.extend(wide(&format!("{key}={value}"))?);
    }
    env.push(0); if environment.is_empty() { env.push(0); }
    unsafe {
        let job = CreateJobObjectW(null(), null()); if job.is_null() { return Err(io::Error::last_os_error()); }
        let job = OwnedHandle::from_raw_handle(job);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(SetInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of_val(&limits) as u32))?;
        let (stdout, stdout_child) = pipe()?; let (stderr, stderr_child) = pipe()?; let (stdin_child, stdin_writer) = pipe()?;
        drop(stdin_writer);
        check(SetHandleInformation(stdout.as_raw_handle(), HANDLE_FLAG_INHERIT, 0))?;
        check(SetHandleInformation(stderr.as_raw_handle(), HANDLE_FLAG_INHERIT, 0))?;
        let attributes = Attributes::new()?;
        let mut jobs = [job.as_raw_handle()]; let mut handles = [stdin_child.as_raw_handle(), stdout_child.as_raw_handle(), stderr_child.as_raw_handle()];
        check(UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST as usize, jobs.as_mut_ptr().cast(), size_of_val(&jobs), null_mut(), null()))?;
        check(UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_mut_ptr().cast(), size_of_val(&handles), null_mut(), null()))?;
        let mut startup: STARTUPINFOEXW = zeroed(); startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes.list; startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_child.as_raw_handle(); startup.StartupInfo.hStdOutput = stdout_child.as_raw_handle(); startup.StartupInfo.hStdError = stderr_child.as_raw_handle();
        let mut info: PROCESS_INFORMATION = zeroed();
        check(CreateProcessW(executable.as_ptr(), command.as_mut_ptr(), null(), null(), 1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env.as_ptr().cast(), cwd.as_ptr(), &startup.StartupInfo, &mut info))?;
        let root = OwnedHandle::from_raw_handle(info.hProcess); drop(OwnedHandle::from_raw_handle(info.hThread));
        let mut creation: FILETIME = zeroed(); let mut exit = zeroed(); let mut kernel = zeroed(); let mut user = zeroed();
        // The Job already owns the process; any later error drops the Job and kills its members.
        check(GetProcessTimes(root.as_raw_handle(), &mut creation, &mut exit, &mut kernel, &mut user))?;
        Ok(Process { job, root, pid: info.dwProcessId, creation: format!("{:08x}{:08x}", creation.dwHighDateTime, creation.dwLowDateTime), stdout: File::from(stdout), stderr: File::from(stderr) })
    }
}

pub fn open_host(pid: u32) -> io::Result<OwnedHandle> {
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { Err(io::Error::last_os_error()) } else { Ok(OwnedHandle::from_raw_handle(handle)) }
    }
}
pub fn ended(handle: &OwnedHandle) -> bool { unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_OBJECT_0 } }
pub fn exit_code(root: &OwnedHandle) -> io::Result<u32> { unsafe { let mut code = 0; check(GetExitCodeProcess(root.as_raw_handle(), &mut code))?; Ok(code) } }
pub fn active(job: &OwnedHandle) -> io::Result<u32> {
    unsafe {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
        check(QueryInformationJobObject(job.as_raw_handle(), JobObjectBasicAccountingInformation, (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), size_of_val(&info) as u32, null_mut()))?;
        Ok(info.ActiveProcesses)
    }
}
pub fn terminate(job: &OwnedHandle) -> io::Result<()> { unsafe { check(TerminateJobObject(job.as_raw_handle(), 1)) } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn quotes_argument_boundaries() {
        assert_eq!(quote(""), "\"\""); assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("c:\\folder\\"), "\"c:\\folder\\\\\""); assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }
}
