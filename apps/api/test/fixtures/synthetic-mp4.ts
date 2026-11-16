// A minimal synthetic MP4 for TRAIN-001 R4 tests: ftyp, an mdat of padding, then moov/mvhd with
// the given duration (moov at the end, as a non-faststart file would have it). Not playable.

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

export function syntheticMp4(seconds: number, padding = 64, version: 0 | 1 = 0): Buffer {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "latin1"));
  const mvhd = Buffer.alloc(version === 1 ? 112 : 100);
  mvhd[0] = version;
  if (version === 1) {
    mvhd.writeUInt32BE(1000, 20);
    mvhd.writeBigUInt64BE(BigInt(Math.round(seconds * 1000)), 24);
  } else {
    mvhd.writeUInt32BE(1000, 12);
    mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  }
  return Buffer.concat([ftyp, box("mdat", Buffer.alloc(padding, 7)), box("moov", box("mvhd", mvhd))]);
}
