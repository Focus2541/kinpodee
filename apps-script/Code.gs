/**
 * กินพอดี — ตัวกลางวิเคราะห์รูปอาหารด้วย Gemini
 *
 * ตั้งค่าใน Project Settings → Script properties:
 *   GEMINI_API_KEY  (จำเป็น)  key จาก https://aistudio.google.com/apikey
 *   APP_TOKEN       (จำเป็น)  รหัสลับที่ตั้งเอง ต้องตรงกับที่กรอกในแอป
 *   MODEL           (ไม่บังคับ) ค่าเริ่มต้น gemini-flash-latest
 *
 * Deploy → New deployment → Web app
 *   Execute as: Me   |   Who has access: Anyone
 */

const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // base64 ~3 MB

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (!props.getProperty('APP_TOKEN') || req.token !== props.getProperty('APP_TOKEN')) {
      return json_({ ok: false, error: 'รหัสลับไม่ถูกต้อง' });
    }
    if (req.action === 'ping') return json_({ ok: true, version: 2 });

    if (req.action === 'text') {
      const name = String(req.text || '').trim().slice(0, 120);
      if (!name) return json_({ ok: false, error: 'ไม่พบชื่ออาหาร' });
      if (!rateOk_()) return json_({ ok: false, error: 'ใช้งานถี่เกินไป รอสักครู่แล้วลองใหม่' });
      const r = analyze_(null, null, name, props);
      return json_({ ok: true, items: r.items || [], note: r.note || '' });
    }

    if (!req.image || typeof req.image !== 'string') return json_({ ok: false, error: 'ไม่พบรูปภาพ' });
    if (req.image.length > MAX_IMAGE_CHARS) return json_({ ok: false, error: 'รูปใหญ่เกินไป' });
    if (!rateOk_()) return json_({ ok: false, error: 'ใช้งานถี่เกินไป รอสักครู่แล้วลองใหม่' });

    const result = analyze_(req.image, req.mime || 'image/jpeg', req.hint || '', props);
    return json_({ ok: true, items: result.items || [], note: result.note || '' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function analyze_(b64, mime, hint, props) {
  const fromText = !b64;
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('ยังไม่ได้ตั้ง GEMINI_API_KEY');
  const model = props.getProperty('MODEL') || 'gemini-flash-latest';

  const prompt = fromText
    ? 'คุณเป็นนักโภชนาการไทย ผู้ใช้กินอาหาร/เครื่องดื่มชื่อ "' + hint + '" ' +
      'ประเมินค่าพลังงานและสารอาหารของ 1 ที่ตามขนาดที่ขายทั่วไปในประเทศไทย (เช่น เครื่องดื่มร้านกาแฟ 1 แก้ว 16 ออนซ์ หวานปกติ) ' +
      'ถ้าเป็นจานที่มีหลายอย่างให้แยกเป็นหลายรายการ ถ้าเป็นเมนูเดียวให้ตอบรายการเดียว ใช้ชื่อภาษาไทยที่คนทั่วไปเรียก หน่วยเป็นภาษาไทย ' +
      'ถ้าไม่ใช่ชื่ออาหารให้ items เป็นรายการว่าง และอธิบายใน note สั้น ๆ เป็นภาษาไทย'
    : 'คุณเป็นนักโภชนาการไทย ดูรูปอาหารนี้แล้วแยกเป็นรายการอาหารแต่ละอย่างที่เห็น ' +
    'ประเมินปริมาณจากขนาดภาชนะในรูป แล้วให้ค่าพลังงานและสารอาหารของ "ปริมาณที่เห็นในรูป" ' +
    'ใช้ชื่ออาหารไทยที่คนทั่วไปเรียก หน่วยเป็นภาษาไทย เช่น จาน ชาม ถ้วย ทัพพี ฟอง ไม้ แก้ว ' +
    'คิดน้ำมันที่ใช้ปรุงด้วย ถ้าไม่ใช่รูปอาหาร ให้ items เป็นรายการว่าง และอธิบายใน note ' +
    'note ให้เขียนสั้น ๆ ไม่เกิน 1 ประโยค เป็นภาษาไทย' +
    (hint && !fromText ? '\nข้อมูลเพิ่มเติมจากผู้ใช้: ' + String(hint).slice(0, 200) : '');

  const body = {
    contents: [{ parts: fromText ? [{ text: prompt }] : [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                unit: { type: 'STRING' },
                kcal: { type: 'NUMBER' },
                protein: { type: 'NUMBER' },
                carbs: { type: 'NUMBER' },
                fat: { type: 'NUMBER' },
                confidence: { type: 'STRING', enum: ['สูง', 'กลาง', 'ต่ำ'] }
              },
              required: ['name', 'unit', 'kcal', 'protein', 'carbs', 'fat']
            }
          },
          note: { type: 'STRING' }
        },
        required: ['items']
      }
    }
  };

  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    }
  );
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) {
    const msg = data.error && data.error.message ? data.error.message : 'HTTP ' + code;
    throw new Error('Gemini: ' + msg);
  }
  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('AI ไม่ได้ตอบกลับ ลองถ่ายใหม่ให้เห็นอาหารชัดขึ้น');
  const out = JSON.parse(text);
  out.items = (out.items || []).slice(0, 12).map(function (i) {
    return {
      name: String(i.name || 'อาหาร').slice(0, 80),
      unit: String(i.unit || '1 ที่').slice(0, 30),
      kcal: Math.max(0, Math.round(+i.kcal || 0)),
      p: Math.max(0, Math.round((+i.protein || 0) * 10) / 10),
      c: Math.max(0, Math.round((+i.carbs || 0) * 10) / 10),
      f: Math.max(0, Math.round((+i.fat || 0) * 10) / 10),
      conf: i.confidence || ''
    };
  });
  return out;
}

/** จำกัดไม่เกิน 30 ครั้ง/ชั่วโมง กันคนอื่นเอาไปใช้จนโควตาหมด */
function rateOk_() {
  const cache = CacheService.getScriptCache();
  const k = 'rate_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMddHH');
  const n = Number(cache.get(k) || 0);
  if (n >= 30) return false;
  cache.put(k, String(n + 1), 3700);
  return true;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** กด Run ฟังก์ชันนี้ครั้งแรกเพื่ออนุญาตสิทธิ์ และเช็กว่า key ใช้ได้ */
function testSetup() {
  const props = PropertiesService.getScriptProperties();
  ['GEMINI_API_KEY', 'APP_TOKEN'].forEach(function (k) {
    Logger.log(k + ': ' + (props.getProperty(k) ? 'ตั้งแล้ว' : 'ยังไม่ได้ตั้ง'));
  });
  const model = props.getProperty('MODEL') || 'gemini-flash-latest';
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
    {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': props.getProperty('GEMINI_API_KEY') || '' },
      payload: JSON.stringify({ contents: [{ parts: [{ text: 'ตอบคำว่า พร้อม' }] }] })
    }
  );
  Logger.log('Gemini (' + model + '): HTTP ' + res.getResponseCode());
  Logger.log(res.getContentText().slice(0, 300));
}
