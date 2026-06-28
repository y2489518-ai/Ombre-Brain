# 更新日志 / Changelog

本项目版本号见根目录 `VERSION` 文件，Docker 镜像 tag 与之对应（`p0luz/ombre-brain:<VERSION>`）。

## 2.3.20

### 修复 / Fixed

- **`breath(importance_min=N)` 在高重要度桶塞满上限时，刚被 `trace` 降级的桶看似「未刷新」**
  之前 `breath(importance_min=N)` 把所有符合阈值的桶按 importance 降序排，直接截取前 20 条。当 `importance=10` 的桶超过 20 个时，一个刚用 `trace` 从 10 降到 9 的桶会被高分桶挤出列表，看起来像「trace 改了 importance 但 breath 没刷新」。
  现在改为先给每个符合阈值的 importance 档位（10、9…）各预留一条最近更新的桶，再按正常排序填满剩余名额，确保降级后的桶在其档位仍可见。
  （`src/tools/breath/importance.py` `_select_importance_buckets`；回归测试见 `tests/test_trace_importance_regression.py`）

  > 说明：`trace` 写入 importance 后，`breath` 是每次从磁盘实时重读、无缓存，本身不存在「需要额外操作触发刷新」。若 `trace` 降级看似无效，请先确认目标桶不是 `pinned`/`protected`——这类核心桶 importance 被锁定为 10，`trace` 会拒绝降级并返回提示，需先 `trace(bucket_id, pinned=0)` 再调整 importance。

### 维护 / Chores

- 修正 `.gitignore`：`docs/secrets/`（复数）此前未被忽略，补上规则，避免本地密钥/设计稿目录被纳入版本控制。
