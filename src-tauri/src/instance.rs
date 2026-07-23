use std::{
    env,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::PathBuf,
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const PROTOCOL_MAGIC: &[u8; 8] = b"GBOSSIPC";
const PROTOCOL_VERSION: u32 = 1;
const ACKNOWLEDGED: u8 = 1;
const MAX_ARGUMENTS: usize = 32;
const MAX_STRING_BYTES: usize = 64 * 1024;
const MAX_ENDPOINT_BYTES: u64 = 1024;
const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const RETRY_DELAY: Duration = Duration::from_millis(25);

pub struct LaunchRequest {
    pub args: Vec<String>,
    pub cwd: String,
}

pub enum InstanceMessage {
    Launch(LaunchRequest),
    Fatal(String),
}

pub struct InstanceGuard {
    _file: File,
}

pub struct InstanceOwner {
    pub guard: InstanceGuard,
    pub receiver: Receiver<InstanceMessage>,
}

pub enum InstanceClaim {
    Primary(InstanceOwner),
    Forwarded,
}

struct Endpoint {
    port: u16,
    token: String,
}

pub fn claim_or_forward() -> Result<InstanceClaim, String> {
    let instance_dir = instance_directory()?;
    std::fs::create_dir_all(&instance_dir).map_err(|error| {
        format!(
            "Failed to create instance directory {}: {error}",
            instance_dir.display()
        )
    })?;
    let lock_path = instance_dir.join("instance.lock");
    let mut file = open_lock_file(&lock_path)?;
    let started = Instant::now();
    let request = LaunchRequest {
        args: env::args_os()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect(),
        cwd: env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    };

    loop {
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => return start_primary(file),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => {
                return Err(format!(
                    "Failed to claim the GitBoss process lock at {}: {error}",
                    lock_path.display()
                ));
            }
        }

        if let Ok(endpoint) = read_endpoint(&mut file) {
            if forward_request(&endpoint, &request).is_ok() {
                return Ok(InstanceClaim::Forwarded);
            }
        }

        if started.elapsed() >= FORWARD_TIMEOUT {
            return Err(format!(
                "Another GitBoss process owns {}, but did not acknowledge this launch within {} seconds.",
                lock_path.display(),
                FORWARD_TIMEOUT.as_secs()
            ));
        }

        thread::sleep(RETRY_DELAY);
    }
}

fn start_primary(mut file: File) -> Result<InstanceClaim, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Failed to create the local GitBoss IPC listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to inspect the local GitBoss IPC listener: {error}"))?
        .port();
    let token = instance_token();

    write_endpoint(
        &mut file,
        &Endpoint {
            port,
            token: token.clone(),
        },
    )
    .map_err(|error| format!("Failed to publish the local GitBoss IPC endpoint: {error}"))?;

    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("gitboss-instance-ipc".to_string())
        .spawn(move || listen_for_launches(listener, token, sender))
        .map_err(|error| format!("Failed to start the local GitBoss IPC listener: {error}"))?;

    Ok(InstanceClaim::Primary(InstanceOwner {
        guard: InstanceGuard { _file: file },
        receiver,
    }))
}

fn listen_for_launches(listener: TcpListener, token: String, sender: Sender<InstanceMessage>) {
    loop {
        let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = sender.send(InstanceMessage::Fatal(format!(
                    "The local GitBoss IPC listener failed: {error}"
                )));
                return;
            }
        };

        let request = match read_request(&mut stream, &token) {
            Ok(request) => request,
            Err(_) => continue,
        };

        if sender.send(InstanceMessage::Launch(request)).is_err() {
            return;
        }

        if stream.write_all(&[ACKNOWLEDGED]).is_err() {
            continue;
        }
    }
}

fn forward_request(endpoint: &Endpoint, request: &LaunchRequest) -> io::Result<()> {
    let address: std::net::SocketAddr =
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port).into();
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)?;
    configure_stream(&stream)?;
    stream.write_all(PROTOCOL_MAGIC)?;
    write_u32(&mut stream, PROTOCOL_VERSION)?;
    write_string(&mut stream, &endpoint.token)?;
    write_string(&mut stream, &request.cwd)?;
    write_u32(
        &mut stream,
        request
            .args
            .len()
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too many arguments"))?,
    )?;

    for argument in &request.args {
        write_string(&mut stream, argument)?;
    }

    stream.flush()?;
    let mut acknowledgement = [0];
    stream.read_exact(&mut acknowledgement)?;

    if acknowledgement[0] != ACKNOWLEDGED {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "GitBoss did not acknowledge the forwarded launch",
        ));
    }

    Ok(())
}

fn read_request(stream: &mut TcpStream, expected_token: &str) -> io::Result<LaunchRequest> {
    configure_stream(stream)?;
    let mut magic = [0; PROTOCOL_MAGIC.len()];
    stream.read_exact(&mut magic)?;

    if &magic != PROTOCOL_MAGIC || read_u32(stream)? != PROTOCOL_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported GitBoss IPC protocol",
        ));
    }

    if read_string(stream)? != expected_token {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid GitBoss IPC token",
        ));
    }

    let cwd = read_string(stream)?;
    let argument_count = read_u32(stream)? as usize;

    if argument_count > MAX_ARGUMENTS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "too many GitBoss launch arguments",
        ));
    }

    let mut args = Vec::with_capacity(argument_count);
    for _ in 0..argument_count {
        args.push(read_string(stream)?);
    }

    Ok(LaunchRequest { args, cwd })
}

fn configure_stream(stream: &TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))
}

fn write_string(writer: &mut impl Write, value: &str) -> io::Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() > MAX_STRING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "GitBoss IPC string exceeds the size limit",
        ));
    }

    write_u32(
        writer,
        bytes
            .len()
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "string is too long"))?,
    )?;
    writer.write_all(bytes)
}

fn read_string(reader: &mut impl Read) -> io::Result<String> {
    let length = read_u32(reader)? as usize;
    if length > MAX_STRING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "GitBoss IPC string exceeds the size limit",
        ));
    }

    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_u32(writer: &mut impl Write, value: u32) -> io::Result<()> {
    writer.write_all(&value.to_be_bytes())
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; size_of::<u32>()];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

fn write_endpoint(file: &mut File, endpoint: &Endpoint) -> io::Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    write!(
        file,
        "{}\n{}\n{}\n",
        PROTOCOL_VERSION, endpoint.port, endpoint.token
    )?;
    file.sync_data()
}

fn read_endpoint(file: &mut File) -> io::Result<Endpoint> {
    file.seek(SeekFrom::Start(0))?;
    let mut contents = String::new();
    file.take(MAX_ENDPOINT_BYTES)
        .read_to_string(&mut contents)?;
    let mut lines = contents.lines();
    let version = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing endpoint version"))?
        .parse::<u32>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    if version != PROTOCOL_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported endpoint version",
        ));
    }

    let port = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing endpoint port"))?
        .parse::<u16>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let token = lines
        .next()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing endpoint token"))?
        .to_string();

    Ok(Endpoint { port, token })
}

fn open_lock_file(path: &PathBuf) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let file = options
        .open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(file)
}

fn instance_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("io.gitboss.desktop"))
            .ok_or_else(|| "LOCALAPPDATA is not set; refusing to start GitBoss.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library/Application Support/io.gitboss.desktop"))
            .ok_or_else(|| "HOME is not set; refusing to start GitBoss.".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".local/share/io.gitboss.desktop"))
            .ok_or_else(|| "HOME is not set; refusing to start GitBoss.".to_string());
    }

    #[allow(unreachable_code)]
    Err("GitBoss single-process enforcement is unsupported on this platform.".to_string())
}

fn instance_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    format!("{:x}-{timestamp:x}", std::process::id())
}
