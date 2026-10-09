# Pics support

Pics is a photo and video gallery for Windows. Everything runs on your PC: there's no account and nothing is uploaded. Here are answers to common questions, and how to get help.

## Getting started
1. Open Pics and choose **Add folder**. Pick the folders that hold your photos and videos, for example Pictures, Videos or a folder on another drive.
2. Pics shows them on one timeline right away. In the background it makes previews, finds faces (**People**) and prepares search. With a big library this takes a while the first time, and you can keep using Pics meanwhile.

## Common questions

**HEIC photos or HEVC videos (from iPhones) don't show.**
Install Microsoft's **HEIF Image Extensions** and **HEVC Video Extensions** from the Microsoft Store, then restart Pics.

**People, search or the magic eraser are slow.**
They run on your graphics card when there is one, otherwise on the processor. Settings → Performance shows which is in use. On laptops with two graphics chips, Pics uses the faster one after a restart.

**Where is my data, and how do I start fresh?**
Pics keeps its previews, faces, albums and settings in its own folder on your PC. The Microsoft Store version removes that folder when you uninstall it. In the version from GitHub it's `%APPDATA%\Pics`, and you can delete it after uninstalling. Your photo files are never deleted by uninstalling.

**Did Pics change my photos?**
Only when you asked it to: removing duplicates (to the Recycle Bin or a folder), Organize, saving an edited copy, or writing a rating, tag, date or place into a photo. Every change is listed in **History**, where most can be undone.

**I can't open Private.**
Private opens with Windows Hello or your Pics PIN. If you forgot the PIN, choose **Forgot your PIN?**. Resetting brings the private photos back into your library, so nothing is lost.

**Why can't the Microsoft Store version start with Windows or add "Scan with Pics" to Explorer?**
Windows doesn't let Store apps make those changes. The version from GitHub can.

## Report a problem or ask a question
- **Open an issue:** <https://github.com/KuldipGami/pics-photo-gallery/issues/new>. This needs a free GitHub account. Describe what happened, and include the version shown next to "Pics" in the title bar and your Windows version.
- **Known problems and answers:** <https://github.com/KuldipGami/pics-photo-gallery/issues>

## Privacy
See the [privacy policy](PRIVACY.md). In short, your photos, faces and searches never leave your PC. Only map images are loaded from OpenStreetMap while a map is shown.
