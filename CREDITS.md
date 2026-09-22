# Credits / provenance

`TinyYana/codex-host` 是 [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) 的 **maintained downstream fork**：持續跟進 upstream，同時保留 upstream 目前未提供或沒有計畫採納的修改。這不是已停止跟進 upstream 的獨立演化宣告。感謝 upstream 維護者、貢獻者與 [LINUX DO](https://linux.do/) 社群。

本頁是外部來源與貢獻分類的 Source of Truth；Git 保留逐次變更與作者，設計文件維護行為，完整 license／distribution notice 留在下列專屬入口。本頁不是完整 dependency 清單，也不把設計參考視為程式碼授權。

## Upstream 與 contribution lineage

| 來源 | 現行範圍與證據 | 分類 |
| --- | --- | --- |
| BytePioneer-AI/codex-host 及其貢獻者 | 本專案的直接程式碼基礎；保留 [MIT LICENSE](LICENSE) 與 `Copyright (c) 2026 BytePioneer-AI`。持續同步與 downstream 修改均由 Git ancestry 記錄。 | 直接 upstream；不能將繼承內容全部歸為 downstream 原創。 |
| [SuperGoodGame / PR #221](https://github.com/BytePioneer-AI/codex-host/pull/221) | [原 commit 55db35dc](https://github.com/BytePioneer-AI/codex-host/commit/55db35dc1b6a3cc7266d4e058235f4bbf7e6f7cd) 的 Goal 部分與 review fixes，由 [cb2f5ea98b3e](https://github.com/TinyYana/codex-host/commit/cb2f5ea98b3eb6e6177fce1680f9b8c17b3f221c) re-land。現存 [Claude Goal](packages/adapters/claude-code/src/claude-goal.ts)、[Host Goal](packages/host-runtime/src/external-thread-goal.ts) 及 Claude Goal 測試與原 commit 相同；不包含該 PR 的 file-change 工作。 | 現行 upstream contributor code re-land，適用既有 MIT LICENSE。 |
| [daodao97 / PR #117](https://github.com/BytePioneer-AI/codex-host/pull/117) | [f43252d0](https://github.com/BytePioneer-AI/codex-host/commit/f43252d0fa6b7746802528cce69b0bb076a7875d) 的 [AccountRateLimits](packages/host-runtime/src/codex-runtime/account-rate-limits.ts) cache、observe、reset、in-flight 核心仍在使用；[fb70e99a](https://github.com/BytePioneer-AI/codex-host/commit/fb70e99a22f434046fbf5c1c638183d45f11b093) 與 f43252d0 的 [帳號／usage 契約](packages/shared-contracts/src/codex-accounts.ts) 仍有存續。 | 部分現行 upstream contribution；舊 per-account home／runtime pool／Thread routing 架構屬歷史，不代表整份貢獻已消失。 |
| [BytePioneer-AI / PR #252](https://github.com/BytePioneer-AI/codex-host/pull/252)、[PR #262](https://github.com/BytePioneer-AI/codex-host/pull/262) | [ead8028d 的設計 §3](https://github.com/TinyYana/codex-host/blob/ead8028d716c809b10128ff6a7559c949dde93ad/docs/codex-native-account-switching-design.md) 記錄從 #252 選擇性移植私有檔案、process supervision、全域帳號契約／Renderer 及測試。現行 [process supervision](crates/platform/src/process_supervision.rs) 的退出等待仍延續 ead8028d。 | Upstream native-account 前身與延續；這裡依歷史設計與現行 blame 記錄，不宣稱已逐行核對 #252 的全部原始碼。 |

原 #117 架構被 #262 取代；[f3592bdb](https://github.com/TinyYana/codex-host/commit/f3592bdb02ce9b938ed29be25b8051c48ccc50dc) 曾移除多帳號管理。現行 [2849d82e](https://github.com/TinyYana/codex-host/commit/2849d82ef6afdd988098476cf567a1c5e53c376e) 再重落縮小範圍的原生交易核心，改採明確保存目前帳號、不提供 Host login、不終止外部 Codex 行程。詳見[現行帳號設計](docs/product/codex-native-account-switching-design.md)。

## 第三方實作與素材 reuse

### OpenCodex

[lidge-jun/opencodex](https://github.com/lidge-jun/opencodex/tree/2d4d7a22381a2e497c2442902104619e25f937c7)，來源固定於 `2d4d7a22381a2e497c2442902104619e25f937c7`。這是 **adapted / reused code 與設計來源**，不能只稱 inspiration。

- 現行 [native credential envelope](packages/host-runtime/src/account/native-codex-credentials.ts) 與 [inactive quota reading](packages/host-runtime/src/account/native-account-quotas.ts) 的來源由 [implementation design](openspec/changes/implement-codex-native-accounts/design.md) 明確記錄；引入 lineage 可追到 ead8028d。
- 原 native profile manager/store/recovery/stage-store 曾是 credential transaction、加密儲存、staging 與 recovery 的重要設計參考。舊 `native-profile-transaction.ts`／`native-profile-vault.ts` 在 [fa700d4e](https://github.com/TinyYana/codex-host/commit/fa700d4eb2ef21873b8a642f6d562c3489abea50) 移除；不能因此宣稱現版仍採用那套完整 journal／encrypted vault／staging 實作，也不能刪除仍存續 reuse 的 notice。
- 保留 [完整 MIT license](third-party/opencodex.LICENSE)，copyright 為 `2026 opencodex contributors`，對應[固定版原文](https://github.com/lidge-jun/opencodex/blob/2d4d7a22381a2e497c2442902104619e25f937c7/LICENSE)。installer payload 與 npm package 均分發 `licenses/opencodex-LICENSE.txt`，並在 `THIRD_PARTY_NOTICES.txt` 記錄來源、revision 與 license 路徑。

### 其他已有專屬來源記錄

| 範圍 | 分類與權威入口 |
| --- | --- |
| 從 zai-org/ZCode 引入並適配的十個 Agent skills | 開發文件／範例的實際 reuse，來源 pin `872ad960de7ec172591f7e1952f7849229f94521`；見 [.agents/skills/NOTICE.md](.agents/skills/NOTICE.md) 的逐項來源、Z.AI Apache-2.0 與 Vercel 子來源授權。這些不是產品 runtime。React Best Practices 原完整 copyright/license notice 的既有缺口仍明確保留，不能把 MIT metadata 當作已取得完整原文。 |
| create-dmg installer background | 素材 reuse；[保留的 MIT notice](scripts/release/macos/assets/LICENSE-create-dmg-background.txt) 記錄 Andrey Tarantsov、Andrew Janke。installer payload 分發對應 license。 |
| Harness／產品品牌圖示 | 實際素材使用、裁切或變體，不是架構 inspiration；來源與改動見 [Renderer assets](packages/renderer-extension/src/assets/README.md) 及 [Launcher assets](crates/launcher/assets/README.md)。根 MIT 不代表授予第三方品牌權利。 |
| Bundled dependencies（包括 Lucide） | 版本與完整授權由 [payload writer](scripts/release/prepare-payload.mjs)、[npm writer](scripts/release/prepare-npm.mjs) 及各自生成的 `THIRD_PARTY_NOTICES.txt`／`licenses/` 管理；不在此複製清單。 |

## 架構、演算法與產品設計參考

### claude-fuel

感謝 [kuohsuanlo/claude-fuel](https://github.com/kuohsuanlo/claude-fuel) 的 `best`、`consume-first`、`waste-first` 策略與 quota headroom／waste／reset 思路。現行 [quota-ranker.ts](packages/host-runtime/src/account/quota-ranker.ts) 在 2849d82e 引入，當時未記錄此來源或採用 revision；本次補上概念 credit。

比對來源為 [302b301f 的 autoswitch.py](https://github.com/kuohsuanlo/claude-fuel/blob/302b301f861d2b12071f062f088023fade764794/src/claude_swap/autoswitch.py)，這是**查證 revision，不是已證明的 import revision**。其 waste 以剩餘百分比／距 weekly reset 小時計算，consume-first 按 weekly reset 排序；本地以 longest-window elapsed × headroom 計算 waste、consume-first 取 `100 - headroom`、best 取 `headroom + waste × 50`。因此分類為策略與演算法概念參考，並非移植相同公式或已確認的 substantial code reuse。

來源 [MIT LICENSE](https://github.com/kuohsuanlo/claude-fuel/blob/302b301f861d2b12071f062f088023fade764794/LICENSE) 的 copyright 是 `2026 Onur Cetinkol`，不能用 repository owner 取代。現有證據不支持新增 copied-code 分發聲明。

### cc-switch

感謝 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 的 credential rollback 設計參考。[managed-account design](openspec/changes/add-codex-managed-accounts/design.md) 曾明寫 `cc-switch's newer-generation rule`。比對 [56df6513 的 codex_config.rs](https://github.com/farion1231/cc-switch/blob/56df6513943062e8ca9eb80d8928eef7cf08a76d/src-tauri/src/codex_config.rs) 的 `restore_preserving_newer_same_account_auth`；此 pin 同樣只是查證 revision。來源 [MIT LICENSE](https://github.com/farion1231/cc-switch/blob/56df6513943062e8ca9eb80d8928eef7cf08a76d/LICENSE) 為 `Copyright (c) 2025 Jason Young`。

分類為**設計參考**。現行 CodexHost rollback 會 capture／restore；未寫入目標時保留停機期間更新的 credential，但沒有 cc-switch 同帳號 identity + timestamp 的 newer-generation predicate。不能把原設計引用當成完整規則已實作或程式碼已移植的證據。

### Paseo 與其他行為參考

- [getpaseo/paseo](https://github.com/getpaseo/paseo)：multi-Harness 架構、Claude callback／usage telemetry／transcript noise 分類與產品行為參考。[Claude adapter design](openspec/changes/archive/2026-07-29-verify-claude-code-adapter-semantics/design.md) 明確排除複製其 AGPL provider／persistent Timeline；[transcript recovery design](openspec/changes/archive/2026-08-20-stabilize-claude-external-thread-recovery/design.md) 記錄獨立分類實作。現行 [model option style](packages/renderer-extension/src/renderer-model-option-style.ts) 也註明參考 Paseo FavoriteStar 視覺行為，實際 icon 使用 Lucide。這些是架構／行為與視覺設計 inspiration，不是 Paseo code import。
- CodexPlusPlus：[Renderer intent design](openspec/changes/archive/2026-07-27-verify-renderer-thread-intent-binding/design.md) 記錄 direct CDP、動態 chunk 與 request wrapping 的行為參考，明確表示獨立實作、不複製 AGPL code。保留這項既有來源脈絡，不推定未記錄的來源 revision。

## 調查邊界與後續維護

本次核對 Git ancestry／blame／diff、現行程式、OpenSpec、保留 license 與兩條發行 notice 鏈。`chuspeeism/dashi-taskboard` 在 tracked source、文件、OpenSpec、commit messages 與歷史字串搜尋中未找到進入現行實作的證據，因此不列為採用來源；這不代表斷言從未研究過該專案。

新增 substantial 外部 code、re-land contribution、明確演算法或產品設計来源時，須在同一變更更新本頁：

1. 記錄作者／repo、PR、固定 source revision、引入 commit、現行檔案與採用範圍；不確定或只有比對版本時明說。
2. 分清直接 upstream、contribution re-land、code／asset reuse、設計參考與歷史範圍；名稱相同或曾研究過不構成 code reuse 證據。
3. 實際 reuse 保留必要 copyright、完整 license／notice；若隨產品分發，同步 payload/npm writer、資產清單與相應局部檢查。不要以本页取代完整授權原文。
4. README 保留短 credit 與本頁入口；設計文件只連回來源記錄。移除實作時更新歷史分類，逐項確認是否仍有衍生程式碼後再調整 notice。

已有完整來源的開發 skills、品牌素材與 dependency 清單沿用各自入口；上述 React skill 缺口不等於已解決，也不影響 OpenCodex 已核對的完整 MIT 分發鏈。
