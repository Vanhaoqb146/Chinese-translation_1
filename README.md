# 🎙 VoiceTranslate AI

Ứng dụng dịch thuật giọng nói thời gian thực, hỗ trợ đa ngôn ngữ, tích hợp AI (OpenAI Whisper + GPT). Xây dựng trên nền tảng **Next.js 16** với giao diện Premium Dark Theme hiện đại.

---

## ✨ Tính năng chính

### 📋 Chế độ Dịch thuật (Standard Mode)
- **Nhận diện giọng nói** qua Web Speech API (`SpeechRecognition`)
- **Tự động dịch** sau 1 giây im lặng — không cần bấm nút dừng
- **Phát âm (TTS)** bản dịch tự động qua `SpeechSynthesis` API
- **Nút 🔊** nghe lại bất kỳ câu nào trong lịch sử
- **Lịch sử dịch thuật** hiển thị ngay bên dưới (tối đa 50 bản ghi)
- Hỗ trợ hoán đổi ngôn ngữ nguồn ↔ đích nhanh chóng

### 💬 Chế độ Giao tiếp (Conversation Mode)
- **VAD (Voice Activity Detection)** tích hợp — tự động phát hiện khi người dùng nói và ngừng nói
- **Tự động nhận diện ngôn ngữ** qua Whisper API (`mode=conversation`) — không cần chọn thủ công
- **Định tuyến dịch thông minh**: Phát hiện ngôn ngữ nói → dịch sang ngôn ngữ còn lại
- **Tạm tắt mic khi phát TTS** — chống nhiễu tiếng vọng từ loa
- **Lịch sử cuộc hội thoại** được giữ nguyên khi chuyển tab qua lại
- **Xử lý graceful** khi Whisper trả về kết quả rỗng (tiếng ồn, tạp âm)

### 🌍 Ngôn ngữ hỗ trợ

| Cờ | Ngôn ngữ | Mã STT | Mã dịch | Mã TTS |
|----|----------|--------|---------|--------|
| 🇨🇳 | 中文 (Trung Quốc) | `zh-CN` | `zh` | `zh-CN` |
| 🇻🇳 | Tiếng Việt | `vi-VN` | `vi` | `vi-VN` |
| 🇺🇸 | English | `en-US` | `en` | `en-US` |
| 🇯🇵 | 日本語 (Nhật) | `ja-JP` | `ja` | `ja-JP` |
| 🇰🇷 | 한국어 (Hàn) | `ko-KR` | `ko` | `ko-KR` |

### 🔐 Hệ thống xác thực
- Đăng nhập bằng tên đăng nhập / mật khẩu
- Phân quyền **Admin** / **User**
- Admin có nút truy cập trang quản trị (`/admin`)
- Dữ liệu người dùng lưu tại `data/users.json`

---

## 🏗 Kiến trúc dự án

```
Chinese-translation_1/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── page.js                   # Trang chính — quản lý state, TTS, chuyển tab
│   │   ├── globals.css               # CSS toàn cục — Premium Dark Theme
│   │   ├── layout.js                 # Root layout
│   │   ├── admin/                    # Trang quản trị Admin
│   │   │   └── page.js
│   │   └── api/                      # API Routes (Server-side)
│   │       ├── whisper/route.js      # Nhận diện giọng nói (OpenAI Whisper)
│   │       ├── translate/route.js    # Dịch thuật (GPT-4o-mini / DeepSeek)
│   │       ├── auth/login/route.js   # Xác thực đăng nhập
│   │       └── admin/users/route.js  # CRUD quản lý người dùng
│   ├── components/
│   │   ├── ConversationPanel.js      # UI chế độ Giao tiếp (Toggle Mic)
│   │   ├── LoginForm.jsx             # Form đăng nhập
│   │   └── login.css                 # CSS form đăng nhập
│   ├── hooks/
│   │   ├── useSpeechRecognition.js   # Hook nhận diện giọng nói (Web Speech API)
│   │   ├── useAutoConversation.js    # Hook giao tiếp tự động (VAD + Whisper)
│   │   ├── useManualConversation.js  # Hook giao tiếp thủ công (MediaRecorder)
│   │   └── useTranslation.js         # Hook quản lý hàng đợi dịch thuật
│   └── lib/                          # Utility functions
├── data/
│   └── users.json                    # Cơ sở dữ liệu người dùng (JSON)
├── public/                           # Static assets
├── .env.local                        # Biến môi trường (API keys)
├── package.json
└── next.config.mjs
```

---

## 🔄 Luồng hoạt động

### Chế độ Dịch thuật

```
Bấm Mic → Web Speech API nhận diện giọng nói
    ↓
Hiển thị interim text (realtime)
    ↓
1s im lặng → auto-stop → lấy final transcript
    ↓
Gọi API /api/translate (GPT-4o-mini)
    ↓
Hiển thị bản dịch + Tự động phát TTS
    ↓
Lưu vào lịch sử
```

### Chế độ Giao tiếp

```
Click Mic (Toggle ON) → Mở AudioContext + mic stream
    ↓
VAD liên tục phân tích RMS (ngưỡng 0.01)
    ↓
Phát hiện tiếng nói → Bắt đầu ghi + giữ 0.8s pre-roll
    ↓
1.2s im lặng → Cắt chunk → Đóng gói WAV
    ↓
Gửi POST /api/whisper (mode=conversation, auto-detect ngôn ngữ)
    ↓
Nhận text + detected language → Định tuyến dịch
    ↓
Gọi POST /api/translate → Nhận bản dịch
    ↓
Pause mic → Phát TTS bản dịch → Resume mic
    ↓
Lặp lại cho đến khi Click Mic (Toggle OFF)
```

---

## 🚀 Cài đặt & Chạy

### Yêu cầu
- **Node.js** >= 18.x
- **npm** >= 9.x
- **OpenAI API Key** (cho Whisper + GPT)

### 1. Cài đặt dependencies

```bash
npm install
```

### 2. Cấu hình biến môi trường

Tạo file `.env.local` tại thư mục gốc:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

> **Lưu ý:** Người dùng cũng có thể nhập API Key trực tiếp qua giao diện Settings (⚙️) mà không cần file `.env.local`.

### 3. Chạy Development Server

```bash
npm run dev
```

Mở [http://localhost:3000](http://localhost:3000) trên trình duyệt.

### 4. Build Production

```bash
npm run build
npm run start
```

---

## 🌐 Deploy lên Vercel

```bash
# Cài Vercel CLI
npm i -g vercel

# Deploy
vercel --prod
```

Hoặc kết nối trực tiếp repository GitHub với [Vercel Dashboard](https://vercel.com/new).

> **Quan trọng:** Cấu hình `OPENAI_API_KEY` trong phần **Environment Variables** của project trên Vercel.

---

## 📡 API Endpoints

### `POST /api/whisper`
Nhận diện giọng nói từ file audio.

| Tham số | Kiểu | Mô tả |
|---------|------|-------|
| `audio` | File | File audio (WAV/WebM) |
| `apiKey` | string | OpenAI API Key (optional) |
| `mode` | string | `standard` hoặc `conversation` |
| `srcLang` | string | Mã ngôn ngữ nguồn (vd: `vi`) |
| `tgtLang` | string | Mã ngôn ngữ đích (vd: `zh`) |

**Response:**
```json
{
  "text": "Xin chào, tôi cần tìm đường",
  "language": "vietnamese"
}
```

- Mode `standard`: Ép Whisper nhận diện theo `srcLang` → chính xác hơn
- Mode `conversation`: Whisper tự phát hiện ngôn ngữ → linh hoạt hơn
- Tích hợp **bộ lọc hallucination** cho các cụm từ phổ biến trên YouTube/social media

---

### `POST /api/translate`
Dịch văn bản giữa hai ngôn ngữ.

| Tham số | Kiểu | Mô tả |
|---------|------|-------|
| `text` | string | Văn bản cần dịch |
| `sourceLang` | string | Mã ngôn ngữ nguồn |
| `targetLang` | string | Mã ngôn ngữ đích |
| `engine` | string | `openai` hoặc `deepseek` |
| `apiKey` | string | API Key (optional) |
| `history` | array | Lịch sử hội thoại để dịch chính xác hơn |

**Response:**
```json
{
  "translation": "你好，我需要找路"
}
```

---

### `POST /api/auth/login`
Xác thực đăng nhập người dùng.

| Tham số | Kiểu | Mô tả |
|---------|------|-------|
| `username` | string | Tên đăng nhập |
| `password` | string | Mật khẩu |

---

## 🧩 Custom Hooks

### `useSpeechRecognition({ lang, onResult, onInterim, onError })`
Hook nhận diện giọng nói sử dụng Web Speech API.
- **`continuous = false`** — Dừng tự động sau mỗi câu nói
- **Smart timer 1s** — Tự động stop nếu 1 giây im lặng
- Trả về: `{ start, stop, abort, elapsed }`

### `useAutoConversation({ apiKey, engine, srcLangCode, tgtLangCode, ... })`
Hook quản lý giao tiếp tự động VAD-based.
- Thu âm PCM qua `ScriptProcessorNode` (4096 samples/frame)
- VAD tích hợp (RMS threshold = 0.01)
- **Pre-roll buffer 800ms** — Giữ lại 0.8s trước khi VAD kích hoạt
- Export WAV chuẩn → gửi Whisper
- Trả về: `{ isListening, elapsed, start, stop, pause, resume }`

### `useTranslation()`
Hook quản lý hàng đợi dịch thuật.
- Queue-based: Đảm bảo các request dịch được xử lý tuần tự
- Trả về: `{ isTranslating, queueTranslation, flush }`

---

## 🛡 Xử lý lỗi & Edge Cases

| Tình huống | Xử lý |
|-----------|-------|
| Whisper trả rỗng (tiếng ồn) | Reset UI → `convStatus = 'listening'`, không gọi Translate |
| TTS bị kẹt queue (Chrome Mobile) | `speechSynthesis.cancel()` + 50ms delay trước mỗi utterance |
| AudioContext đã closed khi chuyển tab | Guard `state !== 'closed'` trước `.close()` |
| Mất đầu câu (audio clipping) | Pre-roll buffer 800ms giữ lại âm thanh trước VAD |
| Hallucination từ Whisper | Bộ lọc `BAD_PHRASES` loại bỏ cụm từ YouTube/social |
| Lịch sử mất khi chuyển tab | State nâng lên `page.js` (parent), truyền qua props |

---

## 🛠 Công nghệ sử dụng

| Công nghệ | Phiên bản | Mục đích |
|-----------|-----------|----------|
| Next.js | 16.1.6 | Framework full-stack (App Router) |
| React | 19.2.3 | UI Library |
| OpenAI Whisper API | Latest | Nhận diện giọng nói (STT) |
| OpenAI GPT-4o-mini | Latest | Dịch thuật thông minh |
| Web Speech API | Built-in | STT cho chế độ Dịch thuật |
| SpeechSynthesis API | Built-in | Text-to-Speech (TTS) |
| Web Audio API | Built-in | Thu âm PCM + VAD cho chế độ Giao tiếp |
| Vercel | — | Hosting & Deployment |

---

## 📱 Tương thích

- ✅ Chrome Desktop & Mobile (khuyến nghị)
- ✅ Edge Desktop & Mobile
- ⚠️ Safari (hỗ trợ hạn chế Web Speech API)
- ❌ Firefox (không hỗ trợ Web Speech API)

---

## 📄 License

Private project — All rights reserved.
