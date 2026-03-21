# CCTV HLS Plugin (`hls-plugin.exe`)

## คืออะไร

`hls-plugin.exe` เป็นตัวติดตั้ง (Inno Setup) ของแพ็กเกจ **CCTV-HLS-Plugin** บน Windows หลังติดตั้งจะวางโค้ดและไลบรารีไว้ใต้โฟลเดอร์ผู้ใช้ เช่น `%LocalAppData%\CCTV-HLS-Plugin\` และสามารถลงทะเบียนให้รัน **พร็อกซี HLS** ตอนล็อกอิน (shortcut ใน Startup) ผ่าน `hls-plugin.vbs`

ตัวพร็อกซีจริงคือ `**hls-plugin.js`** (Node.js / Bun) — รับคำขอ HTTP ที่พอร์ต **9555** แล้วใช้ **FFmpeg** แปลงสตรีม **RTSP** (จาก NVR Dahua / Hikvision ฯลฯ) เป็น **HLS** (`playlist.m3u8` + segment `.ts`) เพื่อให้เบราว์เซอร์เล่นผ่าน `<video>` / hls.js ได้ เพราะเบราว์เซอร์เล่น RTSP โดยตรงไม่ได้

สรุป: **เครื่องผู้ใช้ต้องรันปลั๊กอินนี้** ขณะดู CCTV จากเว็บแอป — เว็บเรียก `http://127.0.0.1:9555/...` ไม่ได้ส่ง RTSP ออกอินเทอร์เน็ตโดยตรงจากเบราว์เซอร์

## ทำงานกับเว็บอย่างไร

- แอปฝั่ง frontend ใช้ URL พร็อกซีแบบมี query (เช่น `startOffset` สำหรับ seek) แล้วโหลด HLS ที่พร็อกซีสร้าง
- ลิงก์ดาวน์โหลดตัวติดตั้งใน UI มาจาก getter `**cctvHlsPluginDownloadUrl`** ใน `frontend/assets/js/core/app.js`
  - **GitHub Releases:** URL แบบ `releases/download/...` ใช้ได้แบบไม่ล็อกอินเมื่อ **repository เป็น Public** เท่านั้น — ถ้า repo **Private** ผู้ใช้ทั่วไปโหลดไม่ได้ (ต้องล็อกอิน GitHub หรือใช้ token) จึงควรย้าย `hls-plugin.exe` ไป **repo public แยก**, **object storage สาธารณะ**, หรือ **โฮสต์บนเว็บแอป**
  - **ค่าเริ่มต้นในโค้ด:** ดู URL ใน `app.js` (อัปเดตเมื่อเปลี่ยนแท็ก/โฮสต์)
  - **โฮสต์เอง / override:** ตั้งก่อนโหลดแอป เช่น  
  `window.CCTV_HLS_PLUGIN_DOWNLOAD_URL = 'https://cdn.example.com/hls-plugin.exe';`

## ข้อกำหนดของผู้ใช้ปลายทาง

- Windows
- ติดตั้งปลั๊กอินแล้วให้พร็อกซีรัน (พอร์ต 9555 ว่าง)
- เปิดเว็บจากเครื่องเดียวกับที่รันปลั๊กอิน (หรือตามข้อจำกัด mixed content / loopback ที่แอปแจ้ง)

## สร้างตัวติดตั้ง (`hls-plugin.exe`)

1. เตรียมในโฟลเดอร์ `plugin/`: `hls-plugin.js`, `hls-plugin.vbs`, `ffmpeg\`, `bun.exe` (หรือสิ่งที่ `[Files]` ใน `hls-plugin.iss` อ้างถึง), `mpv.exe` เป็นต้น
2. เปิด `**hls-plugin.iss`** ด้วย [Inno Setup](https://jrsoftware.org/isinfo.php) แล้ว Compile
3. ผลลัพธ์อยู่ที่ `plugin/installer_output/` (ชื่อไฟล์ตาม `OutputBaseFilename` — ปัจจุบันใช้ชื่อฐาน `hls-plugin`)

เวอร์ชันที่แสดงในตัวติดตั้งกำหนดใน `hls-plugin.iss` (`#define MyAppVersion`).

- **`mpv.conf`**: ตั้ง `ontop=yes` ให้หน้าต่าง MPV อยู่หน้าสุดเมื่อเปิดจากเว็บ — ถ้าไม่ต้องการ ตั้ง env `MPV_ONTOP=0` (โค้ดจะไม่ส่ง `--ontop`) หรือแก้ไฟล์ conf หลังติดตั้ง

## API ของพร็อกซี (สรุป)

รายละเอียดอยู่ที่หัวไฟล์ `**hls-plugin.js**` — ตัวอย่าง:

- `GET /ping` — ตรวจว่าพร็อกซีทำงาน
- `GET /hls?u=<rtspUrl>&startOffset=...` — สตาร์ท FFmpeg แล้ว redirect ไป playlist HLS
- `GET /hls/stop?path=<playbackId>` — หยุดสตรีมที่เกี่ยวข้อง

## ความปลอดภัยและขนาด repo

- URL RTSP มักมีข้อมูลล็อกอิน — อย่าเปิด debug โหมดที่พิมพ์ URL เต็มในสภาพ production
- ไฟล์ `hls-plugin.exe` มักใหญ่เกินกว่าจะ commit ใน git ได้สะดวก — ใช้ `**.gitignore**` ที่ `frontend/assets/plugin/hls-plugin.exe` และแจกผ่าน **Releases** หรือโฮสต์ภายใน

