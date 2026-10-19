const core = require('@actions/core');

async function callGemini(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('gemini-api-key', { required: true });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!response.ok) {
    const err = new Error(`Gemini API: ${response.status} - ${await response.text()}`);
    err.status = response.status;
    throw err;
  }
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error(`Empty Gemini response: ${JSON.stringify(result).slice(0, 500)}`);
  return {
    content: text,
    truncated: result.candidates?.[0]?.finishReason === 'MAX_TOKENS',
    usage: {
      input: result.usageMetadata?.promptTokenCount || 0,
      output: result.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

module.exports = {
  callGemini,
};
