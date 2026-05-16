"""Group file management endpoints: list, read, upload, update, delete."""
import asyncio
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

from api.deps import get_current_admin
from api.services import wrappers
from api.schemas import GroupFileInfo, GroupUploadRequest

router = APIRouter(prefix="/api/groups", tags=["groups"], dependencies=[Depends(get_current_admin)])


def _groups_dir() -> Path:
    from code.config import GROUPS_DIR
    return GROUPS_DIR


@router.get("")
async def list_groups():
    groups_dir = _groups_dir()
    files = []
    for p in sorted(groups_dir.iterdir()):
        if p.is_file() and p.suffix == ".txt":
            stat = p.stat()
            content = await asyncio.to_thread(p.read_text, "utf-8", "replace")
            lines = len([l for l in content.splitlines() if l.strip()])
            files.append({
                "filename": p.name,
                "lines": lines,
                "size_bytes": stat.st_size,
            })
    return {"groups": files, "total": len(files)}


@router.get("/{filename}")
async def get_group_file(filename: str):
    groups_dir = _groups_dir()
    filepath = groups_dir / filename
    if not filepath.is_file():
        raise HTTPException(404, f"Group file '{filename}' not found")
    if not filepath.suffix == ".txt":
        raise HTTPException(400, "Only .txt files supported")

    content = await asyncio.to_thread(filepath.read_text, "utf-8", "replace")
    lines = content.splitlines()
    valid_lines = [l for l in lines if l.strip()]
    return {
        "filename": filename,
        "content": content,
        "lines": len(valid_lines),
        "total_lines": len(lines),
    }


@router.post("")
async def create_group_file(body: GroupUploadRequest):
    groups_dir = _groups_dir()
    filename = body.filename
    if not filename.endswith(".txt"):
        filename += ".txt"

    filepath = groups_dir / filename
    if filepath.exists():
        raise HTTPException(409, f"File '{filename}' already exists")

    lines = body.content.splitlines()
    valid_count = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        group_id = parts[0].strip()
        if not group_id.lstrip("-").isdigit():
            raise HTTPException(400, f"Invalid group ID: '{group_id}'")
        valid_count += 1

    await asyncio.to_thread(filepath.write_text, body.content, "utf-8")
    await wrappers.log_admin_action("web_admin", "create_group_file", target=filename)
    return {"filename": filename, "lines": valid_count, "status": "created"}


@router.post("/upload")
async def upload_group_file(file: UploadFile = File(...)):
    groups_dir = _groups_dir()
    filename = file.filename or "uploaded.txt"
    if not filename.endswith(".txt"):
        raise HTTPException(400, "Only .txt files supported")

    filepath = groups_dir / filename
    content = await file.read()
    text = content.decode("utf-8", errors="replace")

    await asyncio.to_thread(filepath.write_text, text, "utf-8")
    lines = len([l for l in text.splitlines() if l.strip()])
    await wrappers.log_admin_action("web_admin", "upload_group_file", target=filename)
    return {"filename": filename, "lines": lines, "status": "uploaded"}


@router.put("/{filename}")
async def update_group_file(filename: str, body: GroupUploadRequest):
    groups_dir = _groups_dir()
    filepath = groups_dir / filename
    if not filepath.is_file():
        raise HTTPException(404, f"Group file '{filename}' not found")

    await asyncio.to_thread(filepath.write_text, body.content, "utf-8")
    lines = len([l for l in body.content.splitlines() if l.strip()])
    await wrappers.log_admin_action("web_admin", "update_group_file", target=filename)
    return {"filename": filename, "lines": lines, "status": "updated"}


@router.delete("/{filename}")
async def delete_group_file(filename: str):
    groups_dir = _groups_dir()
    filepath = groups_dir / filename
    if not filepath.is_file():
        raise HTTPException(404, f"Group file '{filename}' not found")

    await asyncio.to_thread(filepath.unlink)
    await wrappers.log_admin_action("web_admin", "delete_group_file", target=filename)
    return {"filename": filename, "status": "deleted"}
