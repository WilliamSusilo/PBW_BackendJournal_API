# PBW_Backend_API

Backend API project untuk kebutuhan Web App Jurnal PT Prabasena Baratawijaya (Prabaraja), menggunakan Node.js dan Vercel serverless functions.

## 🚀 Tech Stack

- Node.js 20.11.0
- @vercel/node
- Supabase Client (@supabase/supabase-js)
- Express middleware (body-parser, cors)
- Environment management (dotenv)
- ESLint (linting and code style)

## 📦 Installation

### Clone this repository

```bash
git clone https://github.com/your-username/pbw_backend_api.git
cd pbw_backend_api
```

### Install dependencies

Pastikan Node.js dan npm sudah terinstall di sistem kamu.

```bash
npm install
```

## 🛠️ Available Scripts

### Start development server locally

Jalankan server development menggunakan Vercel CLI:

```bash
npm run dev
```

atau

```bash
vercel dev
```

### Linting project

Cek kode menggunakan ESLint:

```bash
npm run lint
```

## ⚙️ Project Structure

```bash
pbw_backend_api/
├── api/             # Folder berisi semua endpoint API (.js files)
├── vercel.json      # Konfigurasi Vercel deployment
├── package.json     # Daftar dependencies dan scripts
├── eslint.config.mjs# Konfigurasi linting dengan ESLint
├── .env             # (Opsional) File environment variables
```

## 🌐 Environment Variables

Pastikan membuat file `.env` di root project (jika diperlukan) dengan isi seperti:

```ini
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```

> Note: Sesuaikan key sesuai kebutuhan aplikasi.

## 📤 Deployment

Untuk deployment, pastikan kamu sudah menginstall Vercel CLI:

```bash
npm install -g vercel
```

Kemudian deploy project:

```bash
vercel
```

Ikuti instruksi di terminal untuk memilih scope, project, dan link ke dashboard Vercel.

## 🧹 Additional Notes

- API routes didefinisikan dalam folder `api/` dan otomatis tersedia via route `/api/{your-file}`.
- Menggunakan `@vercel/node` sebagai builder untuk menjalankan fungsi serverless di Vercel.
- Pastikan linting (`npm run lint`) sebelum meng-commit untuk menjaga kualitas kode.
