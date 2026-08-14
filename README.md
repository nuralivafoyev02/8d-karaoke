# 🎧 8D Karaoke

YouTube havolasi yoki MP3/audio faylni **8D formatda jonli** tinglang va qo'shiq matnini
**karaoke** kabi animatsiya bilan ko'ring.

Listen to any song **live in 8D** and watch the lyrics **karaoke-style** with word-by-word highlighting.

## Imkoniyatlar (Features)

- 🔗 **YouTube havola** — yt-dlp orqali avtomatik yuklab olinadi
- 📁 **Fayl yuklash** — MP3, WAV, M4A, OGG, FLAC, OPUS va boshqalar
- 🎧 **Jonli 8D effekt** — Web Audio API: aylanuvchi stereo pan (LFO) + aks-sado (reverb).
  Barcha sozlamalar (aylanish tezligi, kuch, aks-sado) **o'ynash paytida** o'zgaradi
- 📝 **Karaoke lirika** — faster-whisper (AI) so'z-darajali vaqt belgilari bilan matnni
  topadi; so'zlar sinxron yonadi va avtomatik aylanadi. So'zni bosib — shu joyga o'ting
- 🌐 O'zbekcha interfeys + inglizcha izohlar

## Arxitektura (Architecture)

```
Brauzer (frontend/)                  Python backend (main.py)
┌─────────────────────────┐          ┌──────────────────────────────┐
│ Web Audio API:          │          │ FastAPI                      │
│  source → pan → reverb  │ ◄─audio─ │  /api/upload   (fayl)        │
│  LFO aylanish (8D)      │          │  /api/youtube  (yt-dlp)      │
│  Karaoke sinxronizatsiya│ ◄─words─ │  /api/jobs/{id}(polling)     │
└─────────────────────────┘          │  faster-whisper (lirika)     │
                                     └──────────────────────────────┘
```

- **8D effekt** faqat brauzerda (Web Audio API) — serverga yuk bo'lmaydi, real-time
- **Lirika** backendda faster-whisper bilan topiladi (so'z-darajali `start/end` vaqtlari)
- Joblar `data/` papkasida saqlanadi, `JOB_TTL_HOURS` dan keyin tozalanadi

## Lokal ishga tushirish (Run locally)

Talablar: **Python 3.9+** va **ffmpeg** (YouTube uchun tavsiya etiladi).

```bash
# 1) ffmpeg o'rnatish (agar yo'q bo'lsa)
#    macOS:  brew install ffmpeg
#    Ubuntu: sudo apt install ffmpeg

# 2) Muhit va kutubxonalar
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 3) Ishga tushirish
uvicorn main:app --reload --port 8000
```

Brauzerda oching: **http://localhost:8000**

> Birinchi ishga tushirishda Whisper modeli (≈150 MB) internetdan yuklab olinadi.
> `WHISPER_MODEL` o'zgaruvchisi bilan o'zgartirish mumkin (masalan `small` — o'zbek tili uchun aniqroq).

### Sozlash (Settings)

| O'zgaruvchi | Standart | Izoh |
|---|---|---|
| `WHISPER_MODEL` | `base` | `tiny`/`base`/`small`/`medium`/`large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cpu` yoki `cuda` (GPU bo'lsa) |
| `WHISPER_COMPUTE` | `int8` | `int8`/`float16`/`float32` |
| `DATA_DIR` | `data` | Joblar papkasi |
| `MAX_UPLOAD_MB` | `100` | Yuklash cheklovi |
| `JOB_TTL_HOURS` | `48` | Eski joblarni tozalash |

## Deploy (Render.com)

1. Reponi GitHub'ga yuklang
2. [render.com](https://render.com) → **New → Blueprint** → reponi tanlang (`render.yaml` avtomatik topiladi)
3. Birinchi so'rovda Whisper modeli yuklanadi (bir necha daqiqa) — keyin ishlaydi

Yoki Docker bilan istalgan joyda:

```bash
docker build -t 8d-karaoke .
docker run -p 8000:8000 -v 8d-data:/data 8d-karaoke
```

## API

| Yo'l | Tavsif |
|---|---|
| `POST /api/youtube` | `{url}` → job yaratadi, background'da yuklab oladi va tahlil qiladi |
| `POST /api/upload` | `multipart` fayl → job yaratadi |
| `GET /api/jobs/{id}` | Job holati: `processing` → `ready` / `error` |
| `GET /api/audio/{id}` | Audio fayl (brauzer o'ynatadi) |
| `GET /api/health` | Server holati |

## YouTube 403 xatosi (Troubleshooting)

Agar "YouTube'dan yuklab bo'lmadi: HTTP Error 403: Forbidden" chiqsa —
YouTube so'rovni bloklagan. Tartibda shu yechimlarni sinab ko'ring:

1. **yt-dlp ni yangilang:** `pip install -U yt-dlp`
2. **Brauzer cookies bering** — YouTube ko'pincha anonim so'rovlarni bloklaydi:
   - "Get cookies.txt LOCALLY" kengaytmasi bilan cookies.txt oling va
     `YT_COOKIES_FILE=/path/to/cookies.txt` qilib ishga tushiring
   - Yoki lokal rejimda: `YT_BROWSER=chrome` (brauzer ma'lumotlaridan o'qiydi)
3. **VPN/proksi o'chiring** — datacenter/VPN IP'lari ko'pincha bloklanadi
4. Video mualliflik huquqi yoki mintaqa bo'yicha cheklangan bo'lishi mumkin

## Eslatmalar (Notes)

- Instrumental asarlarda matn topilmaydi — bu normal holat
- 8D effekt eng yaxshi **naushnikda** eshitiladi 🎧
- Yuqori sifat uchun `WHISPER_MODEL=small` tavsiya etiladi (sekinroq, aniqroq)
