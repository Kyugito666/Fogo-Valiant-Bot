# FOGO Testnet Valiant Bot (Edisi Multi-Dompet Otomatis)

Bot antarmuka pengguna terminal (Node.js) minimal untuk testnet FOGO, kini ditingkatkan dengan kemampuan eksekusi otomatis untuk banyak dompet. Bot ini dapat melakukan perdagangan acak, menambah posisi likuiditas, menyebarkan token uji coba, serta membungkus/membuka FOGO ⇄ SPL FOGO (WSOL). Pilih sebuah tugas, dan bot akan menjalankannya secara berurutan untuk semua dompet Anda.

<img width="1474" height="805" alt="Screenshot (238)" src="https://github.com/user-attachments/assets/105ab4b5-90d8-42dd-84e8-c68f818245c6" />

---

## ✨ Fitur Unggulan Edisi Ini

Versi asli telah dimodifikasi secara ekstensif untuk menyertakan fitur-fitur canggih berikut:

-   **Mode Eksekusi Otomatis (Auto-Run):** Fitur paling signifikan. Pilih satu tugas dari menu (misalnya, "Random Trade"), dan bot akan secara otomatis menjalankannya untuk setiap dompet secara bergiliran, dari awal hingga akhir, tanpa perlu intervensi manual.
-   **Dukungan Multi-Dompet:** Kelola dan jalankan tugas pada puluhan bahkan ratusan dompet dari satu antarmuka.
-   **Dukungan Proksi Fleksibel:** Integrasi dengan proksi HTTP yang dapat diaktifkan atau dinonaktifkan langsung dari menu. Bot akan secara otomatis memuat dan merotasi proksi dari file `proxy.txt`.
-   **Manajemen Kunci Pribadi Terpusat:** Simpan semua kunci pribadi Anda dengan aman di satu file `.env` untuk kemudahan pengelolaan.
-   **Antarmuka Pengguna yang Ditingkatkan:** Antarmuka telah disempurnakan untuk menampilkan daftar dompet, status proksi, dan menyorot dompet yang sedang aktif diproses.
-   **Arsitektur Kode Modular:** Kode telah direfaktorisasi ke dalam kelas (`Wallet`, `MultiWalletBot`) untuk keterbacaan, pemeliharaan, dan skalabilitas yang lebih baik.

---

## 🚀 Persyaratan

-   **Node.js:** Versi 18+ (disarankan 20+).
-   **Akses Internet:** Diperlukan untuk terhubung ke RPC testnet FOGO.
-   **Kunci Pribadi Solana:** Kunci rahasia dalam format **base58**, bukan hex.

---

## 🛠️ Instalasi dan Konfigurasi

Jalankan perintah berikut satu per satu di terminal Anda untuk menginstal dan mengkonfigurasi bot.

1.  **Clone Repositori**
    ```bash
    git clone [https://github.com/kyugito666/fogo-valiant-bot.git](https://github.com/kyugito666/fogo-valiant-bot.git)
    ```

2.  **Masuk ke Direktori Proyek**
    ```bash
    cd fogo-valiant-bot
    ```

3.  **Instal Dependensi**
    ```bash
    npm install
    ```

4.  **Siapkan Kunci Pribadi**
    Buat file bernama `.env` dan isi dengan kunci pribadi Anda dari `pk.txt`. Formatnya harus `PRIVATE_KEYS=` diikuti oleh kunci yang dipisahkan koma.
    ```bash
    echo "PRIVATE_KEYS=$(paste -sd, pk.txt)" > .env
    ```

5.  **Siapkan Daftar Proksi (Opsional)**
    Jika Anda ingin menggunakan proksi, buat file `proxy.txt` dan isi dengan daftar proksi Anda, satu proksi per baris.
    ```bash
    # Contoh: nano proxy.txt
    # Lalu paste daftar proxy Anda
    ```

6.  **Jalankan Bot**
    ```bash
    node kazmight.js
    ```

---

## ⚙️ Menu Tindakan

-   **Perdagangan Acak:** Lakukan perdagangan acak dengan token yang didukung.
-   **Tambah Posisi Acak:** Tambahkan likuiditas ke berbagai pool.
-   **Sebarkan Kontrak Token:** Sebarkan token baru.
-   **Jalankan Semua Fitur:** Jalankan tindakan 1 hingga 3 secara berurutan.
-   **Bungkus FOGO → SPL FOGO:** Ubah FOGO asli menjadi SPL FOGO (WSOL).
-   **Buka SPL FOGO → FOGO:** Ubah SPL FOGO kembali menjadi FOGO asli.
-   **Toggle Proxy ON/OFF:** Mengaktifkan atau menonaktifkan penggunaan proksi dari `proxy.txt`.
-   **Keluar:** Menutup aplikasi.

*Setelah memilih tindakan, bot akan menanyakan jumlah eksekusi per dompet dan memulai proses otomatisnya.*

---

## 教程 Lengkap

Untuk tutorial lengkap dan dukungan, bergabunglah dengan Saluran Telegram kami:
**[https://t.me/invictuslabs](https://t.me/invictuslabs)**

---

## 🙏 Kredit dan Pengakuan

Proyek ini adalah modifikasi dari bot asli yang dibuat oleh **kazmight**. Kami berterima kasih atas pekerjaan dasar mereka.

Modifikasi, fitur multi-dompet, dan sistem auto-run dikontribusikan oleh **Kyugito666**.

| Asli                                                                                      | Dimodifikasi oleh                                                                                |
| :----------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------: |
| [![kazmight](https://avatars.githubusercontent.com/u/129861596?v=4)](https://github.com/kazmight) | [![Kyugito666](https://avatars.githubusercontent.com/u/113055222?v=4)](https://github.com/Kyugito666) |
| **kazmight** | **Kyugito666** |

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah Lisensi MIT. Lihat file `LICENSE` untuk detail lebih lanjut.