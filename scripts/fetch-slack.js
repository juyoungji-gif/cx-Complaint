// 슬랙 #ishopcare_민원공유 채널의 워크플로 제출 메시지를 파싱해
// data/complaints.json 으로 저장한다.
// 워크플로 양식: 접수 일시 / 사업자번호/상호명 / 작성자 / 인입채널 /
//              상담 일시 / 리스크 강도 / 민원유형 / 이슈 내용 /
//              조치 내용 - 드롭다운 / 조치 내용 - 텍스트 입력 / 현재 상태

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
      types: "public_channel",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    const found = data.channels.find((c) => c.name === name);
    if (found) return found.id;
    cursor = data.response_metadata && data.response_metadata.next_cursor;
  } while (cursor);
  throw new Error(`채널을 찾지 못했습니다: #${name}`);
}

function yearStartTs(year) {
  return Math.floor(new Date(`${year}-01-01T00:00:00+09:00`).getTime() / 1000);
}

function tsToDate(ts) {
  const d = new Date(Number(ts) * 1000 + 9 * 60 * 60 * 1000);
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

// ---- 워크플로 양식 필드 파싱 ----
const FIELD_LABELS = [
  "접수 일시",
  "사업자번호/상호명",
  "작성자",
  "인입채널",
  "상담 일시",
  "리스크 강도",
  "민원유형",
  "이슈 내용",
  "조치 내용 - 드롭다운",
  "조치 내용 - 텍스트 입력",
  "현재 상태",
];

function cleanLine(line) {
  // 굵게(*텍스트*), 기울임(_텍스트_) 등 슬랙 서식 기호를 제거하고 비교한다
  return line.replace(/^[\*_~`>#\-•\s]+/, "").replace(/[\*_~`\s]+$/, "").trim();
}

function parseWorkflowMessage(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length);
  const result = {};
  let currentLabel = null;
  let buffer = [];
  const flush = () => {
    if (currentLabel) result[currentLabel] = buffer.join("\n").trim();
    buffer = [];
  };
  for (const line of lines) {
    const cleaned = cleanLine(line);
    const matched = FIELD_LABELS.find((label) => cleaned.startsWith(label));
    if (matched) {
      flush();
      currentLabel = matched;
    } else if (currentLabel) {
      buffer.push(line);
    }
  }
  flush();
  return result;
}

function normalizeRisk(value) {
  if (!value) return "일반";
  return /고위험/.test(value) ? "고위험" : "일반";
}

function normalizeStatus(value) {
  if (!value) return "종결";
  if (/불필요/.test(value)) return "종결";
  if (/완료|종결/.test(value)) return "종결";
  return "대응 필요";
}

function stripPII(value) {
  if (!value) return value;
  return String(value)
    .replace(/\d{2,3}-?\d{3,4}-?\d{4}/g, "[제외]")
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, "[제외]");
}

async function main() {
  const channelId = await findChannelId(CHANNEL_NAME);
  const oldest = yearStartTs(YEAR_FILTER);
  const raw = await fetchAllMessages(channelId, oldest);
  console.log(`슬랙에서 받아온 원본 메시지 수: ${raw.length}`);

  const EXCLUDED_SUBTYPES = new Set([
    "channel_join", "channel_leave", "channel_topic", "channel_purpose",
    "channel_name", "channel_archive", "channel_unarchive",
    "pinned_item", "unpinned_item",
  ]);

  const cases = raw
    .filter((m) => m.text && m.text.trim() && !EXCLUDED_SUBTYPES.has(m.subtype))
    .map((m) => {
      const parsed = parseWorkflowMessage(m.text);
      if (!parsed["접수 일시"] && !parsed["사업자번호/상호명"]) return null; // 워크플로 양식이 아닌 일반 잡담 메시지는 제외

      const [bizId, bizName] = (parsed["사업자번호/상호명"] || "/").split("/").map((s) => (s || "").trim());

      return {
        ts: m.ts,
        date: (parsed["접수 일시"] || tsToDate(m.ts)).slice(0, 10),
        bizId: stripPII(bizId) || "",
        bizName: bizName || "",
        author: stripPII(parsed["작성자"]) || "미상",
        channel: parsed["인입채널"] || "기타",
        consultTime: parsed["상담 일시"] || "",
        risk: normalizeRisk(parsed["리스크 강도"]),
        type: parsed["민원유형"] || "기타",
        issue: parsed["이슈 내용"] || "",
        actionSummary: parsed["조치 내용 - 드롭다운"] || "",
        actionDetail: parsed["조치 내용 - 텍스트 입력"] || "",
        status: normalizeStatus(parsed["현재 상태"]),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.ts) - Number(a.ts)); // 최신순

  const output = {
    updatedAt: new Date().toISOString(),
    channel: CHANNEL_NAME,
    year: YEAR_FILTER,
    count: cases.length,
    cases,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`${cases.length}건의 민원 케이스를 저장했습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
