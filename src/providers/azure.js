const core = require('@actions/core');
const OpenAI = require('openai');

async function callAzureOpenAI(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('azure-api-key', { required: true });
  const endpoint = core.getInput('azure-endpoint', { required: true });
  const deployment = core.getInput('azure-deployment') || model;
  const apiVersion = core.getInput('azure-api-version') || '2024-02-15-preview';
  const client = new OpenAI({
    apiKey,
    baseURL: `${endpoint}/openai/deployments/${deployment}`,
    defaultQuery: { 'api-version': apiVersion },
    defaultHeaders: { 'api-key': apiKey }
  });
  const response = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
    response_format: { type: 'json_object' }
  });
  return {
    content: response.choices[0].message.content,
    truncated: response.choices[0].finish_reason === 'length',
    usage: {
      input: response.usage?.prompt_tokens || 0,
      output: response.usage?.completion_tokens || 0
    }
  };
}

async function callAzureResponsesAPI(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('azure-api-key', { required: true });
  const endpoint = core.getInput('azure-endpoint', { required: true });
  const apiVersion = core.getInput('azure-api-version') || '2025-04-01-preview';
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const url = `${endpoint}/openai/responses?api-version=${apiVersion}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ input: fullPrompt, max_output_tokens: maxTokens, model })
  });
  if (!response.ok) {
    const err = new Error(`Azure Responses API: ${response.status} - ${await response.text()}`);
    err.status = response.status;
    throw err;
  }
  const result = await response.json();
  let content = '';
  if (Array.isArray(result.output)) {
    for (const item of result.output) {
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text') content += c.text || '';
        }
      }
    }
  }
  if (!content) throw new Error(`Unparseable Azure Responses output: ${JSON.stringify(result).slice(0, 500)}`);
  return {
    content,
    truncated: result.status === 'incomplete',
    usage: {
      input: result.usage?.input_tokens || result.usage?.prompt_tokens || 0,
      output: result.usage?.output_tokens || result.usage?.completion_tokens || 0
    }
  };
}

module.exports = {
  callAzureOpenAI,
  callAzureResponsesAPI,
};
