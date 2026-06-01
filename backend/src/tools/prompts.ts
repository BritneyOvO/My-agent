const prompts: Record<string, string> = {
  Read: [
    "Reads a file from the local filesystem.",
    "Usage:",
    "- Prefer an absolute file_path. Relative paths are resolved from the backend workspace directory.",
    "- By default reads up to 2000 lines; use offset and limit for large files.",
    "- Results include 1-based line numbers in cat -n style.",
    "- This tool reads files, not directories. Use LS for directories."
  ].join("\n"),
  Write: [
    "Writes a file to the local filesystem.",
    "Usage:",
    "- Overwrites the existing file if one exists at file_path.",
    "- Prefer Edit for modifying existing files; use Write for new files or complete rewrites.",
    "- Parameters: input={file_path, content}."
  ].join("\n"),
  Edit: [
    "Performs exact string replacements in files.",
    "Usage:",
    "- Parameters: input={file_path, old_string, new_string, replace_all}.",
    "- old_string must match the file content exactly.",
    "- If old_string appears multiple times, provide more surrounding context or set replace_all=true.",
    "- Use old_string=\"\" only to create or replace an empty file."
  ].join("\n"),
  Glob: [
    "Fast file pattern matching tool.",
    "Usage:",
    "- Parameters: input={pattern, path?, head_limit?}.",
    "- Supports glob patterns like **/*.js or src/**/*.ts.",
    "- Results are sorted by modification time when possible."
  ].join("\n"),
  Grep: [
    "Searches file contents with ripgrep.",
    "Usage:",
    "- Parameters: input={pattern, path?, glob?, output_mode?, head_limit?, offset?, multiline?}.",
    "- output_mode can be files_with_matches, content, or count.",
    "- Use glob/type filters to narrow large searches.",
    "- Use multiline=true for regexes that span lines."
  ].join("\n"),
  LS: [
    "Lists a local directory.",
    "Usage:",
    "- Parameters: input={path}.",
    "- Use Read for file contents and Glob/Grep for searching."
  ].join("\n"),
  web_search: [
    "Searches the public web for current information.",
    "Usage:",
    "- Prefer query for the search text.",
    "- Use allowed_domains or blocked_domains when the source scope matters."
  ].join("\n"),
  python: [
    "Runs Python 3 locally.",
    "Usage:",
    "- Use args=[\"-c\", \"code\"] for short reproducible scripts.",
    "- Use artifact_path for an uploaded or local .py script."
  ].join("\n"),
  strings_grep: [
    "Runs strings through ripgrep and returns only matching lines.",
    "Usage:",
    "- Provide artifact_path for the binary/APK/DEX/native library.",
    "- args=[regex, limit?], for example [\"flag|ctf|JNI|Java_|check|encrypt\", \"200\"].",
    "- Prefer this over full strings for APK, DEX, SO, ELF, JAR, and large binaries.",
    "- If matches are too broad, narrow the regex before increasing the limit."
  ].join("\n"),
  r2: [
    "Runs radare2 directly on a binary.",
    "Usage:",
    "- artifact_path points to the binary.",
    "- args are raw r2 CLI arguments such as [\"-A\", \"-c\", \"pdf @ sym.Java_xxx\", \"-c\", \"pd 80 @ 0x21740\"].",
    "- The dispatcher injects -q, scr.color=false, scr.utf8=false, and a final q when missing.",
    "- Empty args run a focused native triage, equivalent to r2_native_scan.",
    "- Keep commands focused: use afl~regex, izz~regex, pdf @ symbol, pd N @ address, axt @ address; full afl/izz/pD/pd dumps are blocked.",
    "- Do not put raw | in r2 commands. Split regex alternatives into multiple -c commands such as [\"-c\", \"izz~flag\", \"-c\", \"izz~ctf\"]."
  ].join("\n"),
  r2_native_scan: [
    "Runs a focused radare2 triage for native CTF libraries.",
    "Usage:",
    "- Provide artifact_path for a .so/ELF.",
    "- It reports binary info, JNI/import hints, flag/check/encrypt-like function names, and matching strings.",
    "- Use r2 next with a specific function/address from this output."
  ].join("\n"),
  jadx_decompile: [
    "Decompiles an APK or DEX with jadx into a local directory.",
    "Usage:",
    "- Provide artifact_path for the APK/DEX.",
    "- Optional args=[output_dir, mode]. Default mode is no-res for speed; pass with-res/full only when resources are needed.",
    "- After this succeeds, use Grep/Glob in the output directory for MainActivity, checkFlag, native, JNI, flag, encrypt, decrypt."
  ].join("\n"),
  apktool_decode: [
    "Decodes APK resources, smali, and AndroidManifest with apktool.",
    "Usage:",
    "- Provide artifact_path for the APK.",
    "- Optional args=[output_dir, mode]. Default mode is no-res to avoid slow resource decoding; pass full/with-res only when resources/layouts are required.",
    "- Use this when smali or manifest matter, or jadx is unavailable/incomplete."
  ].join("\n"),
  aapt_dump: [
    "Runs aapt dump for APK metadata.",
    "Usage:",
    "- Provide artifact_path for the APK.",
    "- Optional args=[badging|permissions|resources|xmltree:AndroidManifest.xml].",
    "- Use early to identify package, launch activity, permissions, and resource IDs without dumping the whole APK."
  ].join("\n"),
  curl: "Runs curl. Put the complete command arguments in args, for example [\"-i\", \"-L\", \"-sS\", \"https://host/\"].",
  whatweb: "Runs whatweb. Put the complete command arguments in args, for example [\"--no-errors\", \"https://host/\"].",
  nmap: "Runs nmap. Put the complete command arguments in args, for example [\"-sV\", \"-p-\", \"host\"].",
  ffuf: "Runs ffuf. Put the complete command arguments in args, for example [\"-u\", \"http://host/FUZZ\", \"-w\", \"words.txt\"].",
  file: "Identifies a local file. Provide artifact_path or a local path in args.",
  strings: "Extracts printable strings from a small local file. Full strings on APK/DEX/SO/large binaries is blocked; use strings_grep with a regex instead.",
  readelf: "Runs readelf with targeted flags only. Do not use -a/--all; prefer readelf_symbols for filtered -Ws or flags like -h, -S, -d, -r.",
  readelf_symbols: "Runs readelf -Ws through rg/head. Provide artifact_path; optional args=[regex, limit], for example [\"JNI|Java_|flag|check|encrypt\", \"200\"].",
  objdump: "Runs objdump with targeted flags only. Full -d is blocked; use --disassemble=<symbol> or r2 for focused function/address inspection.",
  exiftool: "Reads metadata from a local file. Provide artifact_path or a local path in args.",
  binwalk: "Scans a local file for embedded data. Provide artifact_path or a local path in args.",
  tshark_summary: "Runs tshark. Put flags in args yourself, for example [\"-r\", \"/path/capture.pcap\"].",
  unzip_list: "Lists zip archive contents. Provide artifact_path. APK/AAR/JAR output is summarized; use aapt_dump/jadx_decompile/apktool_decode for Android analysis.",
  unzip: "Extracts a zip archive in the archive directory. Provide artifact_path. APK/AAR/JAR extraction logs are summarized; continue with targeted Glob/Grep/readelf_symbols/r2_native_scan.",
  "7z_list": "Lists 7z-supported archive contents. Provide artifact_path.",
  "7z_extract": "Extracts a 7z-supported archive in the archive directory. Provide artifact_path.",
  rar_list: "Lists rar archive contents. Provide artifact_path.",
  rar_extract: "Extracts a rar archive in the archive directory. Provide artifact_path.",
  tar_list: "Lists tar archive contents. Provide artifact_path.",
  tar_extract: "Extracts a tar archive in the archive directory. Provide artifact_path.",
  gzip_decompress: "Decompresses a gzip file in place with -dkf. Provide artifact_path.",
  bzip2_decompress: "Decompresses a bzip2 file in place with -dkf. Provide artifact_path.",
  xz_decompress: "Decompresses an xz file in place with -dkf. Provide artifact_path.",
  wget: "Downloads or probes HTTP resources with wget. Use args like [\"-O\", \"file\", \"url\"] or [\"-qO-\", \"url\"].",
  nc: "Runs netcat for TCP/UDP probing. Use args directly, for example [\"host\", \"port\"] or [\"-vz\", \"host\", \"port\"]. Stdin is not interactive.",
  xxd: "Hex dumps or reverses files. Use args when passing options, for example [\"-l\", \"16\", \"/path/file\"] or [\"-r\", \"in.hex\", \"out.bin\"].",
  hexdump: "Runs hexdump. Put flags in args yourself, for example [\"-C\", \"/path/file\"].",
  nm: "Lists symbols from object files or binaries. Provide artifact_path or a local path in args.",
  gdb: "Runs gdb. Put the complete non-interactive arguments in args, for example [\"-q\", \"-batch\", \"-ex\", \"info functions\", \"/path/binary\"].",
  ltrace: "Traces dynamic library calls. Use args for the program and its arguments, for example [\"./binary\"].",
  strace: "Runs strace. Put flags and the traced program in args, for example [\"-f\", \"./binary\"].",
  steghide: "Runs steghide. Use args explicitly, for example [\"info\", \"file.jpg\"] or [\"extract\", \"-sf\", \"file.jpg\", \"-p\", \"pass\"].",
  stegseek: "Brute-forces steghide passwords. Use args like [\"file.jpg\", \"wordlist.txt\"].",
  zsteg: "Runs PNG/BMP LSB steganography checks. Provide artifact_path or a local path in args.",
  pngcheck: "Runs pngcheck. Put flags in args yourself, for example [\"-v\", \"/path/image.png\"].",
  identify: "Reads ImageMagick image properties. Provide artifact_path or a local path in args.",
  convert: "Transforms images with ImageMagick convert. Provide args explicitly, for example [\"in.png\", \"-enhance\", \"out.png\"].",
  montage: "Tiles images with ImageMagick montage. Provide args explicitly, for example [\"*.png\", \"out.png\"].",
  tesseract: "Runs OCR. Use args like [\"image.png\", \"stdout\"] or [\"image.png\", \"stdout\", \"--psm\", \"6\"].",
  ffmpeg: "Runs ffmpeg. Use args explicitly, for example [\"-hide_banner\", \"-y\", \"-i\", \"in.wav\", \"out.mp3\"].",
  sox: "Processes or analyzes audio. Use args explicitly, for example [\"in.wav\", \"-n\", \"spectrogram\", \"-o\", \"spec.png\"].",
  mmls: "Lists partition layouts with Sleuthkit. Provide artifact_path or disk image path in args.",
  fls: "Lists filesystem entries with Sleuthkit. Use args such as [\"-r\", \"-o\", \"offset\", \"disk.img\"].",
  icat: "Extracts a file by inode with Sleuthkit. Use args such as [\"-o\", \"offset\", \"disk.img\", \"inode\"].",
  tsk_recover: "Recovers files from a filesystem image. Use args such as [\"disk.img\", \"outdir\"].",
  fsstat: "Shows filesystem stats with Sleuthkit. Use args such as [\"-o\", \"offset\", \"disk.img\"].",
  foremost: "Carves files by signatures. Use args such as [\"-i\", \"disk.img\", \"-o\", \"outdir\"].",
  testdisk: "Runs TestDisk. Prefer non-interactive args or use only when a short diagnostic is needed.",
  xfs_db: "Runs XFS debugger. Use args such as [\"-c\", \"sb 0\", \"-c\", \"p\", \"disk.img\"].",
  xfs_repair: "Runs xfs_repair. Put flags in args yourself, for example [\"-n\", \"/path/disk.img\"] for a read-only check.",
  dcfldd: "Runs forensic dd with hashing. Use args explicitly, for example [\"if=in\", \"of=out\", \"hash=md5\"].",
  vol: "Runs volatility3 CLI. Use args such as [\"-f\", \"memdump.raw\", \"windows.info\"].",
  openssl: "Runs OpenSSL. Use args directly for enc, rsa, s_client, x509, dgst, prime, and related operations.",
  RsaCtfTool: "Runs RsaCtfTool for RSA attacks. Use args such as [\"-n\", \"N\", \"-e\", \"E\", \"--attack\", \"all\"].",
  sage: "Runs SageMath. Use args like [\"-c\", \"from sage.all import *; print(factor(n))\"].",
  "cado-nfs": "Runs cado-nfs for large integer factoring or DLP. Use args containing the integer or cado options.",
  flatter: "Runs fast lattice reduction. Use args for input/output files; for stdin-style matrices, write a temp file first.",
  gcc: "Compiles C programs. Use args directly, for example [\"-o\", \"exploit\", \"exploit.c\"].",
  "g++": "Compiles C++ programs. Use args directly, for example [\"-O2\", \"-o\", \"solve\", \"solve.cpp\"].",
  make: "Runs make. Use args for targets or -C directories.",
  cmake: "Runs cmake. Use args for configure/build operations.",
  jq: "Processes JSON. Use args such as [\".\", \"file.json\"] or [\"-r\", \".key\", \"file.json\"].",
  zip: "Creates or updates zip archives. Use args directly, for example [\"-r\", \"out.zip\", \"dir\"].",
  git: "Runs git for repository operations. Use args directly, for example [\"status\", \"--short\"] or [\"clone\", \"url\"].",
  podman: "Runs Podman containers. Use args directly, for example [\"run\", \"-d\", \"-p\", \"8080:80\", \"image\"].",
  "podman-compose": "Runs podman-compose. Use args directly, for example [\"up\", \"-d\"].",
  buildah: "Builds OCI images with buildah. Use args directly, for example [\"bud\", \"-t\", \"image\", \".\"]."
};

export function toolPrompt(name: string) {
  return prompts[name] ?? "Runs the registered local tool. artifact_path, target, input and args are interpreted by the dispatcher.";
}

export function toolPromptSummary(name: string) {
  return toolPrompt(name).split(/\r?\n/)[0] ?? "";
}
