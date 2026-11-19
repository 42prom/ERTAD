// Deliberately no application imports or environment credentials. Input/output only.
import sharp from 'sharp';
import pdfLib from 'pdf-lib';
const { PDFDocument } = pdfLib;
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
console.log = console.warn = console.error = () => {};
globalThis.DOMMatrix = DOMMatrix;
globalThis.ImageData = ImageData;
globalThis.Path2D = Path2D;
const MAX = 5 * 1024 * 1024;
try {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX) throw new Error();
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks);
  let output;
  if (process.argv[2] === 'image') {
    sharp.cache(false);
    sharp.concurrency(1);
    const photo = sharp(source, { limitInputPixels: 16000000, failOn: 'warning' });
    const metadata = await photo.metadata();
    if (!['png', 'jpeg'].includes(metadata.format) || (metadata.pages ?? 1) !== 1)
      throw new Error();
    output = await photo
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .png()
      .timeout({ seconds: 10 })
      .toBuffer();
  } else if (process.argv[2] === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: new Uint8Array(source),
      isEvalSupported: false,
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      stopAtErrors: true,
      maxImageSize: 16000000,
      canvasMaxAreaInBytes: 16000000,
      verbosity: 0,
    });
    task.onPassword = () => {
      void task.destroy();
    };
    const input = await task.promise;
    if (input.numPages < 1 || input.numPages > 5) throw new Error();
    const pdf = await PDFDocument.create();
    // Deterministic output permits an identical interrupted upload to be retried.
    pdf.setCreationDate(new Date(0));
    pdf.setModificationDate(new Date(0));
    pdf.setProducer('ERTAD');
    pdf.setCreator('ERTAD');
    for (let number = 1; number <= input.numPages; number++) {
      const page = await input.getPage(number),
        natural = page.getViewport({ scale: 1 });
      if (
        !Number.isFinite(natural.width * natural.height) ||
        natural.width <= 0 ||
        natural.height <= 0 ||
        natural.width > 3000 ||
        natural.height > 3000
      )
        throw new Error();
      const scale = Math.min(1.5, 2000 / Math.max(natural.width, natural.height));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport,
        annotationMode: 0,
      }).promise;
      const image = await pdf.embedPng(canvas.toBuffer('image/png'));
      pdf
        .addPage([natural.width, natural.height])
        .drawImage(image, { x: 0, y: 0, width: natural.width, height: natural.height });
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
    }
    output = Buffer.from(await pdf.save());
    await task.destroy();
  } else throw new Error();
  if (!output.length || output.length > MAX) throw new Error();
  process.stdout.write(output);
} catch {
  process.exitCode = 1;
}
