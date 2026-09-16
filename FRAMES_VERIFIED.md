# Frames build verification

Date: Wed Sep 16 04:05:06 UTC 2026
Source reel: 4200 frames in assets/frames
Built tiers:
- assets/web-avif: 75 frames per scene, webp q68 step 4, 60M
- assets/web-m: 100 frames per scene, avif q45 step 3, 51M

Verification:
- npm test: 14/14 pass
- manifests 200 OK, frames 200 OK
