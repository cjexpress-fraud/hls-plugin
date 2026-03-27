# HLS Plugin

CCTV Local Service สำหรับเล่นวิดีโอกล้องวงจรปิดใน browser ผ่าน HLS streaming และดาวน์โหลดเป็น MP4

## การติดตั้ง

1. ดาวน์โหลดไฟล์ `hls-plugin.exe` (Installer)
2. ดับเบิลคลิกเพื่อติดตั้ง — ไม่ต้องใช้สิทธิ์ Admin
3. ติดตั้งลงที่ `%LocalAppData%\HLS Plugin\`
4. หลังติดตั้งเสร็จ plugin จะรันทันทีโดยอัตโนมัติ
5. Plugin จะ autorun ทุกครั้งที่เปิดเครื่อง (ผ่าน Registry: `HKCU\...\Run`)

## การใช้งาน

- Plugin ทำงานเป็น **System Tray** (icon ข้างนาฬิกา) — ไม่มีหน้าต่าง terminal
- คลิกขวาที่ icon เพื่อดูเมนู:
  - **HLS Plugin — Running...** — แสดงสถานะ
  - **Exit** — ปิด service

### สำหรับ Developer

รันแบบเห็น log ใน terminal:

```
ดับเบิลคลิก start-cctv.cmd
```

หรือ:

```bash
cd plugin
python main.py
```

## โครงสร้างไฟล์

| ไฟล์ | คำอธิบาย |
|------|----------|
| `hls-plugin.pyw` | System Tray launcher (ใช้กับ `pythonw.exe`) |
| `main.py` | FastAPI application — endpoints ทั้งหมด |
| `ffmpeg.py` | จัดการ ffmpeg process (HLS + download) |
| `config.py` | ค่า config ทั้งหมด (port, paths, limits) |
| `models.py` | Pydantic models |
| `storage.py` | จัดการ directory + cleanup |
| `hls-plugin.iss` | Inno Setup installer script |
| `start-cctv.cmd` | รัน service แบบ terminal (สำหรับ dev) |

## API Endpoints

| Method | Path | คำอธิบาย |
|--------|------|----------|
| `POST` | `/playback/start` | เริ่ม HLS stream จาก RTSP |
| `POST` | `/playback/seek` | Seek ไปตำแหน่งที่ต้องการ |
| `POST` | `/playback/stop` | หยุด stream |
| `POST` | `/download/prepare` | เตรียม streaming download token |
| `GET`  | `/download/stream/{token}` | Stream MP4 ตรงไป browser |
| `GET`  | `/health` | ตรวจสถานะ service |

## Port

Default: `127.0.0.1:9000` (เปลี่ยนได้ผ่าน env `CCTV_PORT`)

## Limits

- Stream พร้อมกัน: 2 (env `CCTV_MAX_STREAMS`)
- Session หมดอายุ: 30 นาที
- Download token หมดอายุ: 2 นาที

## การถอนการติดตั้ง

1. ไปที่ **Settings > Apps > HLS Plugin > Uninstall**
2. Installer จะปิด service และลบ autorun registry ให้อัตโนมัติ

## Troubleshooting

- **Plugin ไม่ทำงาน**: ตรวจว่า icon อยู่ใน System Tray, ถ้าไม่มีให้ติดตั้งใหม่
- **ไม่เจอ ffmpeg**: ตรวจว่ามี `ffmpeg/ffmpeg.exe` ในโฟลเดอร์ที่ติดตั้ง
- **เล่นไม่ได้**: ตรวจ VPN เชื่อมต่อแล้ว, กล้องมี footage ในช่วงเวลานั้น
- **Port ซ้ำ**: ตรวจว่า port 9000 ไม่ถูกใช้งานโดยโปรแกรมอื่น
