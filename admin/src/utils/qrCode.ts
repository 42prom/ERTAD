// Pure ISO/IEC 18004 QR Code (Versions 1-10, Byte mode, ECC Level L) SVG encoder.
// Runs 100% offline with zero network calls so TOTP provisioning secrets never leave the browser.

interface VersionSpec {
  version: number;
  size: number;
  dataCodewords: number;
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
  alignments: number[];
  versionBits?: number;
}

const VERSIONS: VersionSpec[] = [
  { version: 1, size: 21, dataCodewords: 19, ecPerBlock: 7, g1Blocks: 1, g1Data: 19, g2Blocks: 0, g2Data: 0, alignments: [] },
  { version: 2, size: 25, dataCodewords: 34, ecPerBlock: 10, g1Blocks: 1, g1Data: 34, g2Blocks: 0, g2Data: 0, alignments: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecPerBlock: 15, g1Blocks: 1, g1Data: 55, g2Blocks: 0, g2Data: 0, alignments: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecPerBlock: 20, g1Blocks: 1, g1Data: 80, g2Blocks: 0, g2Data: 0, alignments: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecPerBlock: 26, g1Blocks: 1, g1Data: 108, g2Blocks: 0, g2Data: 0, alignments: [6, 30] },
  { version: 6, size: 41, dataCodewords: 136, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 0, g2Data: 0, alignments: [6, 34] },
  { version: 7, size: 45, dataCodewords: 156, ecPerBlock: 20, g1Blocks: 2, g1Data: 78, g2Blocks: 0, g2Data: 0, alignments: [6, 22, 38], versionBits: 0x07c94 },
  { version: 8, size: 49, dataCodewords: 194, ecPerBlock: 24, g1Blocks: 2, g1Data: 97, g2Blocks: 0, g2Data: 0, alignments: [6, 24, 42], versionBits: 0x085bc },
  { version: 9, size: 53, dataCodewords: 232, ecPerBlock: 30, g1Blocks: 2, g1Data: 116, g2Blocks: 0, g2Data: 0, alignments: [6, 26, 46], versionBits: 0x09a99 },
  { version: 10, size: 57, dataCodewords: 274, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 2, g2Data: 69, alignments: [6, 28, 50], versionBits: 0x0a4d3 },
];

// GF(256) with primitive polynomial 0x11d (ISO 18004)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecCount: number): number[] {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Array<number>(data.length + ecCount).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// 15-bit BCH format info for ECC Level L (01) and masks 0..7 (already XOR'd with 0x5412)
const FORMAT_BITS_L = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function buildCodewords(bytes: Uint8Array, spec: VersionSpec): number[] {
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  // Mode indicator 0100 (Byte), char count (8 bits for V1..9, 16 bits for V10+)
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const totalDataBits = spec.dataCodewords * 8;
  const term = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b];
    codewords.push(v);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < spec.dataCodewords) {
    codewords.push(padBytes[padIdx % 2]);
    padIdx++;
  }

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < spec.g1Blocks; i++) {
    const block = codewords.slice(offset, offset + spec.g1Data);
    offset += spec.g1Data;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.g2Blocks; i++) {
    const block = codewords.slice(offset, offset + spec.g2Data);
    offset += spec.g2Data;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }

  const interleaved: number[] = [];
  const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) interleaved.push(ec[i]);
  }
  return interleaved;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSIONS.find((v) => {
    const headerBits = 4 + (v.version <= 9 ? 8 : 16);
    return Math.ceil((headerBits + bytes.length * 8) / 8) <= v.dataCodewords;
  });
  if (!spec) {
    throw new Error("QR payload exceeds V10-L capacity");
  }

  const N = spec.size;
  const grid: (boolean | null)[][] = Array.from({ length: N }, () =>
    Array<boolean | null>(N).fill(null),
  );
  const fixed: boolean[][] = Array.from({ length: N }, () =>
    Array<boolean>(N).fill(false),
  );

  const setFixed = (r: number, c: number, dark: boolean) => {
    grid[r][c] = dark;
    fixed[r][c] = true;
  };

  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= N || c < 0 || c >= N) continue;
        const inBorder =
          dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const inSep = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        setFixed(r, c, !inSep && (inBorder || inCore));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, N - 7);
  drawFinder(N - 7, 0);

  // Alignment patterns
  const centers = spec.alignments;
  for (const r0 of centers) {
    for (const c0 of centers) {
      if (fixed[r0][c0]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const center = dr === 0 && dc === 0;
          setFixed(r0 + dr, c0 + dc, edge || center);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < N - 8; i++) {
    if (!fixed[6][i]) setFixed(6, i, i % 2 === 0);
    if (!fixed[i][6]) setFixed(i, 6, i % 2 === 0);
  }

  // Dark module
  setFixed(N - 8, 8, true);

  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    if (!fixed[8][i]) setFixed(8, i, false);
    if (!fixed[i][8]) setFixed(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!fixed[8][N - 1 - i]) setFixed(8, N - 1 - i, false);
    if (i < 7 && !fixed[N - 1 - i][8]) setFixed(N - 1 - i, 8, false);
  }

  // Version information (V7+)
  if (spec.versionBits !== undefined) {
    for (let i = 0; i < 18; i++) {
      const bit = ((spec.versionBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = N - 11 + (i % 3);
      setFixed(a, b, bit);
      setFixed(b, a, bit);
    }
  }

  const codewords = buildCodewords(bytes, spec);
  const allBits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) allBits.push((cw >>> i) & 1);
  }

  // Place data bits in upward/downward zigzag
  let bitIdx = 0;
  let dir = -1;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    let row = dir === -1 ? N - 1 : 0;
    while (row >= 0 && row < N) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (!fixed[row][c]) {
          grid[row][c] = bitIdx < allBits.length ? allBits[bitIdx] === 1 : false;
          bitIdx++;
        }
      }
      row += dir;
    }
    dir = -dir;
  }

  const maskFn = (mask: number, r: number, c: number): boolean => {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  const applyFormat = (m: boolean[][], maskId: number) => {
    const bits = FORMAT_BITS_L[maskId];
    const bitAt = (pos: number) => ((bits >>> pos) & 1) === 1;
    // Copy 1 (top-left finder perimeter)
    for (let i = 0; i <= 5; i++) m[8][i] = bitAt(14 - i);
    m[8][7] = bitAt(8);
    m[8][8] = bitAt(7);
    m[7][8] = bitAt(6);
    for (let i = 0; i <= 5; i++) m[5 - i][8] = bitAt(5 - i);
    // Copy 2 (bottom-left vertical & top-right horizontal)
    for (let i = 0; i <= 6; i++) m[N - 1 - i][8] = bitAt(14 - i);
    m[N - 8][8] = true; // Fixed dark module
    for (let i = 0; i <= 7; i++) m[8][N - 8 + i] = bitAt(7 - i);
  };

  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix: boolean[][] = [];

  for (let mId = 0; mId < 8; mId++) {
    const cand = grid.map((row, r) =>
      row.map((val, c) =>
        fixed[r][c] ? !!val : !!val !== maskFn(mId, r, c),
      ),
    );
    applyFormat(cand, mId);
    // Simplified ISO penalty score: runs of >= 5 + 2x2 blocks + dark balance
    let score = 0;
    let darkCount = 0;
    for (let r = 0; r < N; r++) {
      let rRun = 1;
      let cRun = 1;
      for (let c = 0; c < N; c++) {
        if (cand[r][c]) darkCount++;
        if (c > 0) {
          if (cand[r][c] === cand[r][c - 1]) rRun++;
          else {
            if (rRun >= 5) score += rRun - 2;
            rRun = 1;
          }
          if (cand[c][r] === cand[c - 1][r]) cRun++;
          else {
            if (cRun >= 5) score += cRun - 2;
            cRun = 1;
          }
        }
        if (
          r < N - 1 &&
          c < N - 1 &&
          cand[r][c] === cand[r + 1][c] &&
          cand[r][c] === cand[r][c + 1] &&
          cand[r][c] === cand[r + 1][c + 1]
        ) {
          score += 3;
        }
      }
      if (rRun >= 5) score += rRun - 2;
      if (cRun >= 5) score += cRun - 2;
    }
    const ratio = Math.abs((darkCount * 100) / (N * N) - 50);
    score += Math.floor(ratio / 5) * 10;
    if (score < bestScore) {
      bestScore = score;
      bestMask = mId;
      bestMatrix = cand;
    }
  }
  void bestMask;
  return bestMatrix;
}

export function qrSvgPath(matrix: boolean[][], margin = 4): { size: number; path: string } {
  const n = matrix.length;
  const parts: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        parts.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }
  return { size: n + margin * 2, path: parts.join("") };
}
