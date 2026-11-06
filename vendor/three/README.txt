three.module.min.js — three.js r160（npm three@0.160.0 の build/three.module.min.js をそのまま同梱・無改変）
ライセンス：MIT（ファイル先頭に表記あり）。Copyright 2010-2023 Three.js Authors
取得：2026-11-06 に cdn.jsdelivr.net と unpkg.com から取得し、両方の sha256 が一致することを確認
sha256: 3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6（670,681 バイト）
用途：算数の工場のゲーム 4 本（計算ゲーム・段ボール・くり上がり工場・MOBかぞえ）が import map で外部 CDN から読む three.js を、
      箱（viewer.html／js/frame.js）が読み込み時に同梱版の data: URL へ差し替える＝オフラインでも・CSP で外部を許さなくても動く。
      （blob: URL にしないのは、sandbox の中のゲームは別オリジンが作った blob を読めないため。実測 2026-11-06）
