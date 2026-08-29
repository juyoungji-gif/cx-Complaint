// 슬랙 #ishopcare_민원공유 채널 메시지를 가져와 data/complaints.json 으로 저장한다.
// 저장소가 Public(무료 GitHub Pages 조건)이기 때문에, 개인정보 보호를 위해
// 원문 텍스트는 저장하지 않고 "유형/상태/담당자/담당팀/날짜"로 분류한 결과만 저장한다.

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_NAME = "ishopcare_민원공유";
const YEAR_FILTER = "2026";
const OUTPUT_PATH = path.join(__dirname, "..", "data", "complaints.json");

if (!TOKEN) {
  console.error("SLACK_BOT_TOKEN 환경변수가 없습니다.");
  process.exit(1);
}

async function slackCall(method, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API 오류 (${method}): ${data.error}`);
  return data;
}

async function findChannelId(name) {
  let cursor;
  do {
    const data = await slackCall("conversations.list", {
      types: "public_channel,private_channel",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    const found = data.channels.find((c) => c.name === name);
    if (found) return found.id;
    cursor = data.response_metadata && data.response_metadata.next_cursor;
  } while (cursor);
  throw new Error(`채널을 찾지 못했습니다: #${name} (봇이 채널에 초대되어 있는지 확인하세요)`);
}

function yearStartTs(year) {
  return Math.floor(new Date(`${year}-01-01T00:00:00+09:00`).getTime() / 1000);
}

function tsToDate(ts) {
  const d = new Date(Number(ts) * 1000 + 9 * 60 * 60 * 1000); // KST 보정
  return d.toISOString().slice(0, 10);
}

async function fetchAllMessages(channelId, oldest) {
  let messages = [];
  let cursor;
  do {
    const data = await slackCall("conversations.history", {
      channel: channelId,
      oldest: String(oldest),
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    messages = messages.concat(data.messages || []);
    cursor = data.response_metadata && data.response_metadata.next_cursor;
  } while (cursor);
  return messages;
}

// ---- 분류 규칙 (필요에 맞게 키워드를 추가/수정하면 됩니다) ----
function classifyType(text) {
  if (/오배송/.test(text)) return "오배송";
  if (/배송\s*지연|배송이\s*늦|배송\s*안\s*옴/.test(text)) return "배송지연";
  if (/불량|파손|하자/.test(text)) return "상품불량";
  if (/환불/.test(text)) return "환불지연";
  if (/반품\s*거부|반품\s*불가/.test(text)) return "반품거부";
  return "기타";
}

function classifyStatus(text) {
  if (/완료|처리\s*완료|해결/.test(text)) return "완료";
  if (/보류|대기/.test(text)) return "보류";
  if (/처리\s*중|진행\s*중|확인\s*중/.test(text)) return "처리중";
  return "신규";
}

function classifyTeam(text) {
  return /반품방어/.test(text) ? "반품방어" : "일반CS";
}

// "담당자: 홍길동", "담당 홍길동", "@홍길동" 등 흔한 패턴에서 담당자명 추출
function extractAssignee(text) {
  const patterns = [
    /담당자\s*[:：]?\s*([가-힣]{2,4})/,
    /담당\s*[:：]?\s*([가-힣]{2,4})/,
    /처리자\s*[:：]?\s*([가-힣]{2,4})/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return "미배정";
}

// 혹시 모를 전화번호/이메일 패턴이 값에 섞여 있으면 마스킹 (안전장치)
function stripPII(value) {
  return String(value)
    .replace(/\d{2,3}-?\d{3,4}-?\d{4}/g, "[제외]")
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, "[제외]");
}

async function main() {
  const channelId = await findChannelId(CHANNEL_NAME);
  const oldest = yearStartTs(YEAR_FILTER);
  const raw = await fetchAllMessages(channelId, oldest);

  const messages = raw
    .filter((m) => m.type === "message" && !m.subtype && m.text && m.text.trim())
    .map((m) => ({
      date: tsToDate(m.ts),
      type: classifyType(m.text),
      status: classifyStatus(m.text),
      team: classifyTeam(m.text),
      assignee: stripPII(extractAssignee(m.text)),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const output = {
    updatedAt: new Date().toISOString(),
    channel: CHANNEL_NAME,
    year: YEAR_FILTER,
    count: messages.length,
    messages, // 원문 텍스트는 포함하지 않음 (개인정보 보호)
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`${messages.length}개의 메시지를 분류해 저장했습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
