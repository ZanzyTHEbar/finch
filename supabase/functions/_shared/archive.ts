export interface ArchiveFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();

const writeText = (target: Uint8Array, offset: number, length: number, value: string): void => {
  const bytes = encoder.encode(value);
  target.set(bytes.slice(0, length), offset);
};

const writeOctal = (target: Uint8Array, offset: number, length: number, value: number): void => {
  writeText(target, offset, length, value.toString(8).padStart(length - 1, "0").slice(-(length - 1)) + "\0");
};

const header = (name: string, byteLength: number): Uint8Array => {
  if (encoder.encode(name).byteLength > 100 || byteLength > 0o77777777777) {
    throw new Error("archive_entry_out_of_range");
  }
  const value = new Uint8Array(512);
  writeText(value, 0, 100, name);
  writeOctal(value, 100, 8, 0o600);
  writeOctal(value, 108, 8, 0);
  writeOctal(value, 116, 8, 0);
  writeOctal(value, 124, 12, byteLength);
  writeOctal(value, 136, 12, 0);
  value.fill(32, 148, 156);
  value[156] = "0".charCodeAt(0);
  writeText(value, 257, 6, "ustar");
  writeText(value, 263, 2, "00");
  const checksum = value.reduce((sum, byte) => sum + byte, 0);
  writeText(value, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
  return value;
};

const join = (chunks: readonly Uint8Array[]): Uint8Array => {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

export const tarGzip = async (files: readonly ArchiveFile[]): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    chunks.push(header(file.name, file.bytes.byteLength), file.bytes);
    const padding = (512 - (file.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const compressed = new Blob([join(chunks)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
};
