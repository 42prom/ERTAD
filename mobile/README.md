# ERTAD mobile foundation

The runnable DTG Flutter application will be migrated incrementally in P2/P4 after identity and permission contracts are reviewed. This folder currently contains generated, framework-independent palette constants only. It is not a runnable Flutter app; no device or Flutter test pass is claimed.

Preserve DTG NFC/camera/liveness/device security behind feature-owned adapters. The source checkout is ../antygravity/mobile; do not copy wallet, blockchain, or national-election flows automatically.

Target navigation: Status / Messages / Home / Tasks / Polls. Home is central. Compact profile entry, safe-area footer, system/light/dark preference, Georgian/English. No full platform administration.

Tokens: design/tokens.json -> npm run tokens -> lib/core/theme/generated_tokens.dart. Web gallery includes visual mobile palette samples, not device validation. The runnable shell will use feature-first structure, Riverpod state/DI, Dio networking and go_router navigation; create layers only where real responsibilities require them.
