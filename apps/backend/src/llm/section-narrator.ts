import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { AppConfig, Category, DigestItem } from '../types.js';

const REPORT_CATEGORIES: Category[] = ['action', 'fyi', 'course', 'admin'];
const CATEGORY_NAMES: Record<Category, string> = {
  action: 'Action 待处理',
  fyi: 'FYI 通知',
  course: 'Course 课程',
  admin: 'Admin 行政',
  junk: 'Junk 促销'
};

const SYSTEM_PROMPT = `你在汇总一份每日邮件日报。下面给出按类别分好的邮件清单（每条是「发件人：摘要」）。请为每个非空类别生成一句 12-25 字的中文总结，概括这批邮件的核心主题或行动点；语气像朋友汇报，不要点名发件人、不要列序号、不要重复类别名。空的类别返回空字符串。

返回 JSON，键固定为 action/fyi/course/admin：
{"action": "...", "fyi": "...", "course": "...", "admin": "..."}`;

export async function summarizeSections(
  config: AppConfig,
  grouped: Record<Category, DigestItem[]>
): Promise<Record<Category, string>> {
  const empty = blankLeads();
  if (config.classifier.provider !== 'openai-compatible' || !config.classifier.llm.apiKey) {
    return empty;
  }
  const userContent = buildUserContent(grouped);
  if (!userContent) {
    return empty;
  }

  try {
    const client = new OpenAI({
      baseURL: config.classifier.llm.baseUrl,
      apiKey: config.classifier.llm.apiKey
    });
    const completion = (await client.chat.completions.create({
      model: config.classifier.llm.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      stream: false
    } as Parameters<typeof client.chat.completions.create>[0])) as ChatCompletion;

    const text = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(text) as Partial<Record<Category, unknown>>;
    return normalizeLeads(parsed);
  } catch (error) {
    console.warn(`Section narrator failed; rendering without leads: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}

function buildUserContent(grouped: Record<Category, DigestItem[]>): string {
  const blocks = REPORT_CATEGORIES
    .filter((category) => grouped[category]?.length > 0)
    .map((category) => {
      const lines = grouped[category]
        .slice(0, 20)
        .map((item) => `- ${displaySender(item.from)}：${snippet(item)}`);
      return `${CATEGORY_NAMES[category]}（${grouped[category].length}）\n${lines.join('\n')}`;
    });
  return blocks.join('\n\n');
}

function snippet(item: DigestItem): string {
  const raw = (item.summary || item.subject || '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 120) || '无摘要';
}

function displaySender(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return ((match?.[1] || from).replace(/\s+/g, ' ').trim()).slice(0, 40);
}

function normalizeLeads(parsed: Partial<Record<Category, unknown>>): Record<Category, string> {
  const leads = blankLeads();
  for (const category of REPORT_CATEGORIES) {
    const value = parsed[category];
    if (typeof value === 'string') {
      leads[category] = value.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return leads;
}

function blankLeads(): Record<Category, string> {
  return { action: '', fyi: '', course: '', admin: '', junk: '' };
}
