const PDF_METADATA_VERSION = 1;

function normalizeQuote(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parsePdfPage(value) {
  const match = /^(?:p(?:age)?\.?\s*)?([1-9]\d*)(?:\s*ページ)?$/i.exec(String(value ?? '').normalize('NFKC').trim());
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

function hasPdfMetadata(item) {
  return item.pdfMetadataVersion === PDF_METADATA_VERSION && Array.isArray(item.pdfPages) &&
    (item.pdfPageCount === null || (Number.isSafeInteger(item.pdfPageCount) && item.pdfPageCount > 0 &&
      item.pdfPages.length === item.pdfPageCount && item.pdfPages.every((page, index) => page.pageNumber === index + 1)));
}

function pdfTextForInput(item, visualInput) {
  const header = visualInput
    ? '[PDF原本のページ画像も入力に含まれます。本文と画像が同じページに混在する場合もあります。]'
    : '[PDFページ画像は送信していません。抽出本文だけを使い、画像部分を読めたものとして引用しないでください。]';
  if (!hasPdfMetadata(item)) return header + '\n' + (item.extractedText || '[ページ別の抽出情報なし]');
  if (!item.pdfPageCount) return header + '\n[PDFを読み取れず、ページ数は不明です。]';
  return header + '\n[原本の総ページ数: ' + item.pdfPageCount + ']\n' + item.pdfPages.map((page) => {
    const state = page.extractionStatus === 'success' ? '本文抽出あり' : page.extractionStatus === 'no_text' ? '本文抽出なし' : '本文抽出エラー';
    const images = page.hasImages === true ? '・画像あり' : page.hasImages === false ? '' : '・画像領域の確認不可';
    return '[p.' + page.pageNumber + '] [' + state + images + ']\n' + (page.text || '') +
      (page.extractionMessage ? '\n[抽出状態: ' + page.extractionMessage + ']' : '');
  }).join('\n\n');
}

// This information comes from the request builder, never the model response.
function sourceInputsForRows(rows, provider, renderedPages = {}) {
  return Object.fromEntries(rows.map(({ item, bytes }) => [item.id, {
    originalAvailable: Boolean(item.attachmentPath && bytes?.length),
    imageSent: item.kind === 'image' && Boolean(bytes?.length),
    visualPages: item.kind !== 'pdf' ? [] : provider === 'openai' && bytes?.length && item.pdfPageCount
      ? item.pdfPages.map((page) => page.pageNumber)
      : provider === 'codex' ? renderedPages[item.id] || [] : []
  }]));
}

function verifyEventQuote(event, source, inputs) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const quote = normalizeQuote(event.quote);
  const matches = (text) => Boolean(quote && normalizeQuote(text).includes(quote));
  assert(quote, 'イベント引用が空です。前回結果を保持しました。');
  assert(event.quoteSource === undefined || ['text', 'image'].includes(event.quoteSource), '引用元は本文または画像を指定してください。');
  const verified = (page, legacy = false) => ({ ...event, page, quoteSource: 'text',
    quoteVerification: legacy ? 'legacy_text_matched' : 'text_matched',
    quoteOrigin: legacy ? '旧形式の本文一致・ページ未照合' : 'テキスト抽出と原文一致' });
  const image = (page) => ({ ...event, page, quoteSource: 'image', quoteVerification: 'image_unverified', quoteOrigin: '画像読取・引用未照合' });
  if (source.kind === 'text') {
    assert(event.quoteSource !== 'image' && matches(source.extractedText), '資料の原文に一致しないイベント引用があったため、前回結果を保持しました。');
    return verified('');
  }
  if (source.kind === 'image') {
    assert(event.quoteSource !== 'text', '画像資料には照合できる抽出本文がありません。');
    assert(inputs?.originalAvailable && inputs.imageSent, '画像引用の原本または今回の画像入力を確認できません。');
    return image('');
  }
  assert(source.kind === 'pdf', '引用元の資料形式を確認できません。');
  if (!hasPdfMetadata(source)) {
    // Old saved sources remain usable without claiming a page-level match.
    assert(event.quoteSource !== 'image' && matches(source.extractedText), 'PDFのページ別原文を確認できません。前回結果を保持しました。');
    return verified(String(event.page || ''), true);
  }
  let number = parsePdfPage(event.page);
  if (!String(event.page || '').trim() && event.quoteSource !== 'image') {
    const candidates = source.pdfPages.filter((page) => matches(page.text));
    if (candidates.length === 1) number = candidates[0].pageNumber;
  }
  assert(number && number <= source.pdfPageCount, 'PDF引用には実在する原本ページ番号が必要です。');
  const page = source.pdfPages[number - 1];
  const mode = event.quoteSource || (matches(page.text) ? 'text' : 'image');
  if (mode === 'text') {
    assert(matches(page.text), '該当PDFページの原文に一致しないイベント引用があったため、前回結果を保持しました。');
    return verified(String(number));
  }
  assert(inputs?.originalAvailable && inputs.visualPages?.includes(number), 'PDF画像引用の原本ページを今回の入力に含めていません。');
  assert(page.readable !== false, '引用元のPDFページを読み取れません。');
  assert(page.hasImages !== false || page.hasNonTextContent !== false, 'このPDFページに画像領域を確認できません。本文引用は原文との照合が必要です。');
  return image(String(number));
}

module.exports = { PDF_METADATA_VERSION, normalizeQuote, parsePdfPage, hasPdfMetadata, pdfTextForInput, sourceInputsForRows, verifyEventQuote };
