// api/saju.js
// Vercel Node.js Serverless Function (Gemini + Supabase logging)
// redeploy trigger: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY registered
// POST { birthDate: "YYYY-MM-DD", birthTime: "HH:MM"|"", timeUnknown: bool, calendarType: "solar"|"lunar", gender: "male"|"female"|"" }
// -> { analysis: string, numbers: number[6], bonus: number }

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST 요청만 지원합니다.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const { birthDate, birthTime, timeUnknown, calendarType, gender } = body;

  if (!birthDate || typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    res.status(400).json({ error: '생년월일(YYYY-MM-DD)을 올바르게 입력해 주세요.' });
    return;
  }

  const timeLabel = (!timeUnknown && birthTime && /^\d{2}:\d{2}$/.test(birthTime)) ? birthTime : '시간 미상';
  const calLabel = calendarType === 'lunar' ? '음력' : '양력';
  const genderLabel = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '미상';

  const systemPrompt = `당신은 한국 전통 사주(四柱) 명리학 스타일의 오락용 콘텐츠를 작성하는 운세 상담가입니다.
사용자의 생년월일과 태어난 시간을 바탕으로 사주팔자(연주/월주/일주/시주)와 오행(五行)의 기운을 짧고 흥미롭게 풀이하고,
그 기운의 특성과 어울리는 1부터 45 사이의 로또 6/45 번호 6개(중복 없이)와 보너스 번호 1개(위 6개와 중복 없이)를 추천하세요.
이것은 실제 당첨 확률에 아무런 영향을 주지 않는 오락 콘텐츠임을 항상 전제로 하며, 그 뉘앙스를 analysis 톤에 은근히 녹여도 좋습니다.
반드시 아래 JSON 형식으로만 응답하고, 다른 설명이나 텍스트는 포함하지 마세요.
{
  "analysis": "사주 풀이를 3~5문장의 자연스럽고 친근한 한국어로 작성",
  "numbers": [정수 6개, 1-45 범위, 중복 없음],
  "bonus": 정수 1개, 1-45 범위, numbers와 중복 없음
}`;

  const userPrompt = `생년월일: ${birthDate}
달력 기준: ${calLabel}
태어난 시간: ${timeLabel}
성별: ${genderLabel}

위 정보를 바탕으로 사주를 풀이하고 로또 번호를 추천해주세요.`;

  let analysis, numbers, bonus;

  try {
    const upstream = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: userPrompt }] },
          ],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.9,
          },
        }),
      }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('Gemini API error:', upstream.status, errText);
      res.status(502).json({ error: 'AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }

    const data = await upstream.json();
    const cand = data && data.candidates && data.candidates[0];
    const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
    const raw = (part && part.text) || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }

    numbers = sanitizeNumbers(parsed.numbers, birthDate + timeLabel);
    bonus = sanitizeBonus(parsed.bonus, numbers, birthDate + timeLabel);
    analysis = (typeof parsed.analysis === 'string' && parsed.analysis.trim())
      ? parsed.analysis.trim()
      : '오늘 당신의 사주 기운이 담긴 번호를 준비했어요.';
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    return;
  }

  // Supabase에 기록 (실패해도 사용자 응답에는 영향 없음)
  await saveToSupabase({
    birth_date: birthDate,
    birth_time: (!timeUnknown && birthTime && /^\d{2}:\d{2}$/.test(birthTime)) ? birthTime : null,
    time_unknown: !!timeUnknown,
    calendar_type: calendarType === 'lunar' ? 'lunar' : 'solar',
    gender: gender === 'male' || gender === 'female' ? gender : null,
    analysis,
    numbers,
    bonus,
  });

  res.status(200).json({ analysis, numbers, bonus });
};

async function saveToSupabase(record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('Supabase 환경변수(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)가 없어 기록을 건너뜁니다.');
    return;
  }
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/rest/v1/saju_draws`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(record),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase insert failed:', resp.status, errText);
    }
  } catch (err) {
    console.error('Supabase insert error:', err);
  }
}

function sanitizeNumbers(arr, seedStr) {
  const valid = Array.isArray(arr)
    ? [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 45))]
    : [];
  let seed = hashString(seedStr || 'seed');
  while (valid.length < 6) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = (seed % 45) + 1;
    if (!valid.includes(n)) valid.push(n);
  }
  return valid.slice(0, 6).sort((a, b) => a - b);
}

function sanitizeBonus(bonus, numbers, seedStr) {
  let n = Number(bonus);
  let seed = hashString((seedStr || 'seed') + 'bonus');
  if (!Number.isInteger(n) || n < 1 || n > 45 || numbers.includes(n)) {
    do {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      n = (seed % 45) + 1;
    } while (numbers.includes(n));
  }
  return n;
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}
