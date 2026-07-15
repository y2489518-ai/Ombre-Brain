"""
========================================
tools/grow/shortpath.py — grow 短内容快速路径
========================================

短内容（<30 字，剥空白后）跳过 dehydrator.digest，直接走 analyze +
merge_or_create，省一次 LLM 拆分调用。

关键行为：
- 调 analyze 拿 domain/valence/arousal/tags/suggested_name
- 用 raw_merge=True 与 hold 对齐：保留原文不压缩
- iter 2.5：【待核实】前缀自动置 needs_verify；新桶触发关联唤起
- 写完 fire-and-forget：plan 自动闭环 + 新桶疑似重复扫描

对外暴露：grow_shortpath(content) → str
========================================
"""

import asyncio
import uuid

from .. import _runtime as rt
from .._common import merge_or_create, check_duplicate_for, check_plan_resolution
from .core import _association_trigger

_VERIFY_PREFIX = "【待核实】"


async def grow_shortpath(content: str) -> str:
    rt.logger.info(f"grow short-content fast path: {len(content.strip())} chars")

    item_content = content.strip()
    needs_verify = False
    if item_content.lstrip().startswith(_VERIFY_PREFIX):
        needs_verify = True
        item_content = item_content.lstrip()[len(_VERIFY_PREFIX):].lstrip()

    try:
        analysis = await rt.dehydrator.analyze(item_content)
    except Exception as e:
        raise RuntimeError(
            f"API key 未配置或调用失败，打标无法完成，桶未创建。请检查 OMBRE_COMPRESS_API_KEY。（错误：{e}）"
        ) from e
    importance = analysis.get("importance", 5) if isinstance(analysis.get("importance"), int) else 5
    batch_id = f"g_{uuid.uuid4().hex[:12]}"
    result_name, is_merged, embed_warn = await merge_or_create(
        content=item_content,
        tags=analysis.get("tags", []),
        importance=importance,
        domain=analysis.get("domain", ["未分类"]),
        valence=analysis.get("valence", 0.5),
        arousal=analysis.get("arousal", 0.3),
        name=analysis.get("suggested_name", ""),
        raw_merge=True,
        source_tool="grow",
        grow_batch_id=batch_id,
    )

    if needs_verify and not is_merged:
        try:
            await rt.bucket_mgr.update(result_name, needs_verify=True)
        except Exception:
            pass

    action = "合并" if is_merged else "新建"
    asyncio.create_task(check_plan_resolution(content, source_bucket_id=result_name))
    if not is_merged:
        asyncio.create_task(check_duplicate_for(result_name, item_content))
        asyncio.create_task(_association_trigger([result_name], {result_name}))
    result = (
        "短内容已按 hold 路径保存为单条记忆，没有拆分。\n"
        f"{action} → {result_name} | "
        f"{','.join(analysis.get('domain', []))} "
        f"V{analysis.get('valence', 0.5):.1f}/A{analysis.get('arousal', 0.3):.1f}"
    )
    if embed_warn:
        result += f"\n⚠️ {embed_warn}"
    return result
