export function parseQuestions(rawText) {
  if (!rawText) return [];
  // Normalize and split
  const text = rawText.replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(Boolean).join('\n');
  const lines = text.split('\n');
  const questions = [];
  let current = null;
  for (let line of lines) {
    const qMatch = line.match(/^(\d{1,4})[\.\)]\s*(.+)/);
    if (qMatch) {
      if (current) questions.push(current);
      current = { id: 'q' + qMatch[1], number: parseInt(qMatch[1]), text: qMatch[2], options: {}, raw: line };
      continue;
    }
    const optMatch = line.match(/^[A-D][\.\)\-]\s*(.+)/i) || line.match(/^\([A-D]\)\s*(.+)/i);
    if (optMatch && current) {
      const key = line.trim()[0].toUpperCase();
      current.options[key] = optMatch[1].trim();
      continue;
    }
    if (current) {
      const optKeys = Object.keys(current.options);
      if (optKeys.length === 0) {
        current.text += ' ' + line;
      } else {
        const last = optKeys[optKeys.length - 1];
        current.options[last] += ' ' + line;
      }
    }
  }
  if (current) questions.push(current);
  questions.forEach(q => q.type = Object.keys(q.options).length >= 2 ? 'mcq' : 'written');
  return questions;
}
