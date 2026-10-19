const core = require('@actions/core');

async function callBedrock(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('bedrock-api-key', { required: true });
  const region = core.getInput('aws-region') || 'us-east-1';
  // Converse API is model-agnostic (Claude, Llama, Mistral, Nova...). Bearer
  // auth uses a Bedrock API key — SigV4/IAM-role auth is intentionally not
  // supported to keep the zero-SDK fetch pattern.
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userPrompt }] }],
      inferenceConfig: { maxTokens, temperature: 0.3 }
    })
  });
  if (!response.ok) {
    const err = new Error(`Bedrock API: ${response.status} - ${await response.text()}`);
    err.status = response.status;
    throw err;
  }
  const result = await response.json();
  const blocks = result.output?.message?.content || [];
  const text = blocks.filter(b => typeof b.text === 'string').map(b => b.text).join('');
  return {
    content: text,
    truncated: result.stopReason === 'max_tokens',
    usage: {
      input: result.usage?.inputTokens || 0,
      output: result.usage?.outputTokens || 0
    }
  };
}

module.exports = {
  callBedrock,
};
