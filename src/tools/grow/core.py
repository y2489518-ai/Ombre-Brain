"""
========================================
tools/grow/core.py — grow 长内容主路径（digest + merge）
========================================

长内容（≥30 字）走这里。先调 dehydrator.digest 把整段拆成 2~6 条
事件项，每条独立尝试 merge_or_create。

关键行为：
- digest 失败（API key 不可用）时直接 RuntimeError，不创建任何桶
- 逐条调 merge_or_create（grow 路径用 LLM merge，会压缩老+新）
- iter 2.0：每次 grow 调用生成一个 ``grow_batch_id``，同批次新建桶共享，
  source_tool 一律为 ``grow``；合并到的老桶不改 source_tool
- iter 2.5：批内去重闸（≥0.85 合并）+ 关联唤起（top3 activation boost）
  + 【待核实】前缀自动置 needs_verify
- 单条失败不影响其他；按字节上限校验单条尺寸
- embedding 失败时桶正常创建，返回追加向量化降级警告
- 末尾 fire-and-forget 触发 plan 自动闭环（用整段原文做匹配）

对外暴露：grow_core(content) → str
========================================
"""

import asyncio
import uuid

from .. import _runtime as rt
from .._common import (
    merge_or_create,
    check_content_size,
    check_duplicate_for,
    check_plan_resolution,
)

_ASSOC_TOP_K = 3
_ASSOC_THRESHOLD = 0.40
_ASSOC_SCAN_K = _ASSOC_TOP_K + 8
_DEDUP_THRESHOLD = 0.85
_VERIFY_PREFIX = "【待核实】"


async def _batch_dedup(items: list[dict]) -> list[dict]:
    """批内去重闸：两两相似度 ≥ 0.85 的合并为一条（保留信息量大的正文，tags 并集）。"""
    if len(items) <= 1 or not rt.embedding_engine or not getattr(rt.embedding_engine, "enabled", False):
        return items

    embeddings = []
    for item in items:
        try:
            emb = await rt.embedding_engine._backend.generate(item.get("content", ""))
            embeddings.append(emb)
        except Exception:
            embeddings.append(None)

    merged_into = set()
    for i in range(len(items)):
        if i in merged_into or embeddings[i] is None:
            continue
        for j in range(i + 1, len(items)):
            if j in merged_into or embeddings[j] is None:
                continue
            sim = rt.embedding_engine._cosine_similarity(embeddings[i], embeddings[j])
            if sim >= _DEDUP_THRESHOLD:
                ci = items[i].get("content", "")
                cj = items[j].get("content", "")
                if len(cj) > len(ci):
                    items[i]["content"] = cj
                items[i]["tags"] = list(set(
                    (items[i].get("tags") or []) + (items[j].get("tags") or [])
                ))
                items[i]["importance"] = max(
                    items[i].get("importance") or 5,
                    items[j].get("importance") or 5,
                )
                merged_into.add(j)
                try:
                    from surfacing_trace import log as stlog
                    stlog("dedup_batch", "", f"item[{j}]→item[{i}]",
                          sim=round(sim, 4),
                          kept_name=items[i].get("name", ""),
                          dropped_name=items[j].get("name", ""))
                except Exception:
                    pass
    return [item for idx, item in enumerate(items) if idx not in merged_into]


async def _association_trigger(new_bucket_ids: list[str], batch_ids: set[str]) -> None:
    """关联唤起：新桶 embedding 对全库算余弦相似，top_k 条做 activation boost。"""
    if not rt.embedding_engine or not getattr(rt.embedding_engine, "enabled", False):
        return

    for bid in new_bucket_ids:
        try:
            new_emb = await rt.embedding_engine.get_embedding(bid)
            if new_emb is None:
                continue
            all_ids = rt.embedding_engine.list_all_ids()
            candidates = []
            for other_id in all_ids:
                if other_id == bid or other_id in batch_ids:
                    continue
                other_emb = await rt.embedding_engine.get_embedding(other_id)
                if other_emb is None:
                    continue
                sim = rt.embedding_engine._cosine_similarity(new_emb, other_emb)
                if sim >= _ASSOC_THRESHOLD:
                    candidates.append((other_id, sim))
            candidates.sort(key=lambda x: x[1], reverse=True)
            for other_id, sim in candidates[:_ASSOC_TOP_K]:
                try:
                    await rt.bucket_mgr.touch(other_id)
                    try:
                        from surfacing_trace import log as stlog
                        stlog("association", other_id,
                              f"triggered_by={bid}",
                              sim=round(sim, 4))
                    except Exception:
                        pass
                except Exception as e:
                    rt.logger.warning(f"association touch failed: {other_id}: {e}")
        except Exception as e:
            rt.logger.warning(f"association_trigger error for {bid}: {e}")


async def grow_core(content: str) -> str:
    try:
        items = await rt.dehydrator.digest(content)
    except Exception as e:
        rt.logger.error(f"Diary digest failed / 日记整理失败: {e}")
        raise RuntimeError(
            f"API key 未配置或调用失败，日记拆分无法完成，桶未创建。请检查 OMBRE_COMPRESS_API_KEY。（错误：{e}）"
        ) from e

    if not items:
        return "内容为空或整理失败。"

    batch_id = f"g_{uuid.uuid4().hex[:12]}"

    # --- 批内去重闸 ---
    pre_count = len(items)
    items = await _batch_dedup(items)
    dedup_merged = pre_count - len(items)

    results = []
    created = 0
    merged = 0
    embed_warnings = []
    new_bucket_ids = []

    for item in items:
        try:
            item_content = item.get("content", "")
            item_tags = item.get("tags") or []

            # --- 待核实标记：【待核实】前缀自动置 needs_verify ---
            needs_verify = False
            if item_content.lstrip().startswith(_VERIFY_PREFIX):
                needs_verify = True
                item_content = item_content.lstrip()[len(_VERIFY_PREFIX):].lstrip()

            size_err = check_content_size(item_content)
            if size_err:
                results.append(f"⚠️{item.get('name', '?')}（{size_err}）")
                continue
            result_name, is_merged, embed_warn = await merge_or_create(
                content=item_content,
                tags=item_tags,
                importance=item.get("importance") or 5,
                domain=item.get("domain") or ["未分类"],
                valence=item.get("valence") or 0.5,
                arousal=item.get("arousal") or 0.3,
                name=item.get("name", ""),
                source_tool="grow",
                grow_batch_id=batch_id,
            )
            if embed_warn and embed_warn not in embed_warnings:
                embed_warnings.append(embed_warn)

            # --- 待核实标记写入 ---
            if needs_verify and not is_merged:
                try:
                    await rt.bucket_mgr.update(result_name, needs_verify=True)
                except Exception:
                    pass

            if is_merged:
                results.append(f"📎{result_name}")
                merged += 1
            else:
                results.append(f"📝{item.get('name', result_name)}")
                created += 1
                new_bucket_ids.append(result_name)
                asyncio.create_task(check_duplicate_for(result_name, item_content))
        except Exception as e:
            rt.logger.warning(
                f"Failed to process diary item / 日记条目处理失败: "
                f"{item.get('name', '?')}: {e}"
            )
            results.append(f"⚠️{item.get('name', '?')}")

    asyncio.create_task(check_plan_resolution(content))

    # --- 关联唤起（fire-and-forget）---
    if new_bucket_ids:
        batch_set = set(new_bucket_ids)
        asyncio.create_task(_association_trigger(new_bucket_ids, batch_set))

    summary = f"{len(items)}条|新{created}合{merged}"
    if dedup_merged:
        summary += f" 去重{dedup_merged}"
    summary += f" batch:{batch_id}\n" + "\n".join(results)
    if embed_warnings:
        summary += f"\n⚠️ {embed_warnings[0]}"
    return summary
