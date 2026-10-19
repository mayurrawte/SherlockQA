const core = require('@actions/core');

async function callOllama(systemPrompt, userPrompt, model, maxTokens) {
  const baseUrl = core.getInput('ollama-base-url') || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.3, num_predict: maxTokens }
    })
  });
  if (!response.ok) {
    const err = new Error(`Ollama API: ${response.status} - ${await response.text()}`);
    err.status = response.status;
    throw err;
  }
  const result = await response.json();
  return {
    content: result.message?.content || '',
    truncated: result.done_reason === 'length',
    usage: {
      input: result.prompt_eval_count || 0,
      output: result.eval_count || 0
    }
  };
}

module.exports = {
  callOllama,
};
