const core = require('@actions/core');
const OpenAI = require('openai');

async function callOpenAI(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('openai-api-key', { required: true });
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model,
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

module.exports = {
  callOpenAI,
};
