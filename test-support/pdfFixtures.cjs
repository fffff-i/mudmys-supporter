const canvasModule = require('@napi-rs/canvas');

function imageFixture(text = '09:00 hidden room unlocked') {
  const canvas = canvasModule.createCanvas(600, 140);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 600, 140);
  context.fillStyle = '#000000';
  context.font = '26px sans-serif';
  context.fillText(text, 15, 80);
  return canvas.toBuffer('image/jpeg');
}

function pdfFixture(pages = [
  { text: '08:10 returned key' },
  { image: '09:00 hidden room unlocked' },
  { text: '10:00 courtyard closed', image: '10:30 lantern on' },
  {}, { text: 'A' }
]) {
  const objects = [null, null, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const add = (object) => { objects.push(object); return objects.length; };
  const stream = (body, dictionary = '') => Buffer.concat([
    Buffer.from('<< ' + dictionary + ' /Length ' + body.length + ' >>\nstream\n'), body, Buffer.from('\nendstream')
  ]);
  const pageIds = pages.map((page) => {
    let content = page.text ? 'BT /F1 12 Tf 20 170 Td (' + page.text.replace(/[\\()]/g, '\\$&') + ') Tj ET\n' : '';
    let imageId;
    if (page.image) {
      const jpeg = imageFixture(page.image);
      imageId = add(stream(jpeg, '/Type /XObject /Subtype /Image /Width 600 /Height 140 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'));
      content += 'q 300 0 0 70 0 30 cm /Im1 Do Q';
    }
    const contentId = add(stream(Buffer.from(content)));
    return add(Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + (page.width || 300) + ' ' + (page.height || 200) +
      '] /Resources << /Font << /F1 3 0 R >> ' + (imageId ? '/XObject << /Im1 ' + imageId + ' 0 R >> ' : '') +
      '>> /Contents ' + contentId + ' 0 R >>'));
  });
  objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objects[1] = Buffer.from('<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>');
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from((index + 1) + ' 0 obj\n'), object, Buffer.from('\nendobj\n')]);
    chunks.push(part);
    length += part.length;
  });
  chunks.push(Buffer.from('xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + length + '\n%%EOF'));
  return Buffer.concat(chunks);
}

module.exports = { pdfFixture, imageFixture };
