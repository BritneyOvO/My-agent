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
  r2: [
    "Runs radare2 directly on a binary.",
    "Usage:",
    "- artifact_path points to the binary.",
    "- args are raw r2 CLI arguments such as [\"-A\", \"-c\", \"iI\", \"-c\", \"afl\", \"-c\", \"pdf @ main\", \"-c\", \"q\"].",
    "- If args is empty, the dispatcher runs a default non-interactive summary: -A -c iI -c afl -c izz -c q."
  ].join("\n"),
  curl: "Runs curl for HTTP probing. Provide target; args are appended as raw curl arguments.",
  whatweb: "Runs whatweb against a URL or host. Provide target.",
  nmap: "Runs nmap service detection. Provide target.",
  ffuf: "Runs ffuf. Provide target as the -u value; args are appended as raw ffuf arguments.",
  file: "Identifies a local file. Provide artifact_path or a local path in args.",
  strings: "Extracts printable strings from a local file. Provide artifact_path or a local path in args.",
  readelf: "Runs readelf -a on a local ELF file. Provide artifact_path or a local path in args.",
  objdump: "Runs objdump -d on a local binary. Provide artifact_path or a local path in args.",
  exiftool: "Reads metadata from a local file. Provide artifact_path or a local path in args.",
  binwalk: "Scans a local file for embedded data. Provide artifact_path or a local path in args.",
  tshark_summary: "Reads a packet capture with tshark -r. Provide artifact_path or a local path in args.",
  unzip_list: "Lists zip archive contents. Provide artifact_path.",
  unzip: "Extracts a zip archive in the archive directory. Provide artifact_path.",
  "7z_list": "Lists 7z-supported archive contents. Provide artifact_path.",
  "7z_extract": "Extracts a 7z-supported archive in the archive directory. Provide artifact_path.",
  rar_list: "Lists rar archive contents. Provide artifact_path.",
  rar_extract: "Extracts a rar archive in the archive directory. Provide artifact_path.",
  tar_list: "Lists tar archive contents. Provide artifact_path.",
  tar_extract: "Extracts a tar archive in the archive directory. Provide artifact_path.",
  gzip_decompress: "Decompresses a gzip file in place with -dkf. Provide artifact_path.",
  bzip2_decompress: "Decompresses a bzip2 file in place with -dkf. Provide artifact_path.",
  xz_decompress: "Decompresses an xz file in place with -dkf. Provide artifact_path."
};

export function toolPrompt(name: string) {
  return prompts[name] ?? "Runs the registered local tool. artifact_path, target, input and args are interpreted by the dispatcher.";
}

export function toolPromptSummary(name: string) {
  return toolPrompt(name).split(/\r?\n/)[0] ?? "";
}
