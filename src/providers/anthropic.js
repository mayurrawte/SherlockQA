const core = require('@actions/core');

async function callAnthropic(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('anthropic-api-key', { required: true });
  const url = 'https://api.anthropic.com/v1/messages';
  // Nudge JSON output by appending a leading "{" assistant turn (Anthropic trick).
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: '{' }
      ]
    })
  });
  if (!response.ok) {
    const err = new Error(`Anthropic API: ${response.status} - ${await response.text()}`);
    err.status = response.status;
    throw err;
  }
  const result = await response.json();
  const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  // We pre-filled "{", so prepend it back when parsing.
  return {
    content: '{' + text,
    truncated: result.stop_reason === 'max_tokens',
    usage: {
      input: result.usage?.input_tokens || 0,
      output: result.usage?.output_tokens || 0
    }
  };
}

module.exports = {
  callAnthropic,
};
