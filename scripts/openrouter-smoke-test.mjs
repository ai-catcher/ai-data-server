import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOnce } from './update-data.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(scriptDirectory, '..', 'config.json'), 'utf8'));
const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

const texts = [
    '甲公司今天发布星河一号手机，公布新处理器和影像系统。',
    '星河一号手机由甲公司正式推出，重点升级芯片与摄像能力。',
    '乙国央行宣布把基准利率下调二十五个基点。',
    '乙国央行降息二十五个基点，市场关注后续货币政策。',
    '丙市地铁三号线今天正式开通，连接机场与市中心。',
    '连接丙市机场和市中心的地铁三号线开始运营。',
];
const entries = texts.map((text, index) => ({ index: index + 1, id: String(90001 + index), text, raw: {} }));
const startedAt = Date.now();
const result = await generateOnce({ ...config, minimum_topics: 3 }, [apiKey], entries);
console.log(JSON.stringify({
    status: 'ok',
    model: result.model,
    grouped_topics: result.groups.length,
    assigned_posts: result.assigned.size,
    duration_ms: Date.now() - startedAt,
}));
