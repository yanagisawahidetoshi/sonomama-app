# ADR-0003: main更新後は再実装せず、再検証runで既存PRを更新する

- 状態: Superseded（2026-11-04、柳沢英俊がPR #315のmergeで承認）
- 日付: 2026-10-30
- 改訂: Accepted（PR #195 のマージで承認。2026-10-31、#175・#193の決定に合わせて実装前Gateの扱いを改めた）
- 判断者: 柳沢英俊（設計案はIssue #144で承認）
- 関連Issue: #144、#148
- Supersedes: なし
- Superseded by: [ADR-0011](0011-no-main-sync-without-conflict.md)

状態の意味とAIの扱いは[README](README.md)を参照する。

## 置き換えの内容

このADRは、ADR-0001がmainが進んだPRをBLOCKEDにしていた前提で、再実装せずに再検証runで既存PRを更新すると決めた（2026-10-30、PR #153）。
ADR-0011でmainが進んだだけではBLOCKEDにしなくなり、再検証runは補助手段になった。今も有効な再検証runの決定はADR-0011へ移した。
元の本文は、PR #315の直前のmain（77ed660）を参照する。

ADRへの変更はHuman Gate対象。AIだけで確定しない。
