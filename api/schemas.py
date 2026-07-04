"""Pydantic request/response schemas for all API endpoints."""
from typing import Optional, Any
from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = 900


class RefreshRequest(BaseModel):
    refresh_token: str


class AdminInfo(BaseModel):
    username: str


class BotSummary(BaseModel):
    name: str
    bot_username: Optional[str] = None
    state: str = "stopped"
    mode: str = "starter"
    sessions_count: int = 0
    cycle: int = 300
    gap: int = 5
    valid_till: Optional[str] = None
    running: bool = False
    frozen: bool = False
    suspended: bool = False


class BotCreateRequest(BaseModel):
    name: str
    # Empty/omitted when use_pool is true — the backend reserves a token from the pool.
    bot_token: str = ""
    use_pool: bool = False
    sessions_count: int = Field(ge=1, le=50)
    cycle: int = Field(ge=60)
    gap: int = Field(ge=1, le=60)
    mode: str = Field(pattern="^(starter|enterprise)$")
    group_file: str = "Starter.txt"
    valid_till: str
    renewal_price: float = 0.0
    plan_name: str = "Custom"
    skip_health_check: bool = False
    skip_chatlist_join: bool = False


class BotUpdateRequest(BaseModel):
    cycle: Optional[int] = None
    gap: Optional[int] = None
    group_file: Optional[str] = None
    valid_till: Optional[str] = None


class BotControlResponse(BaseModel):
    status: str
    message: str


class SessionInfo(BaseModel):
    filename: str
    status: str
    bot_name: Optional[str] = None
    real_name: Optional[str] = None
    user_id: Optional[int] = None


class SessionMoveRequest(BaseModel):
    from_bucket: str
    to_bucket: str


class OrderInfo(BaseModel):
    order_id: str
    user_id: Optional[int] = None
    status: str
    order_type: str = "purchase"
    plan_name: Optional[str] = None
    mode: Optional[str] = None
    amount_usd: Optional[float] = None
    pay_currency: Optional[str] = None
    created_at: Optional[str] = None


class OrderActionResponse(BaseModel):
    success: bool
    message: str


class RecreateOrderRequest(BaseModel):
    skip_health_check: bool = False
    skip_chatlist_join: bool = False


class GroupFileInfo(BaseModel):
    filename: str
    lines: int = 0
    size_bytes: int = 0


class GroupUploadRequest(BaseModel):
    filename: str
    content: str


class DashboardStats(BaseModel):
    bots: dict[str, int]
    sessions: dict[str, int]
    orders: dict[str, int]
    system: dict[str, Any]
    workers: dict[str, Any]


class SystemActionResponse(BaseModel):
    status: str
    message: str


class BroadcastRequest(BaseModel):
    segment: str
    text: str


class BroadcastResponse(BaseModel):
    sent: int
    failed: int
    total: int


class UserSearchResult(BaseModel):
    telegram_id: int
    bots: list[dict[str, Any]] = []


class UserActionRequest(BaseModel):
    bot_token: Optional[str] = None
    days: Optional[int] = None
    freeze: Optional[bool] = None
    new_owner_id: Optional[int] = None


class AlertInfo(BaseModel):
    ts: float
    type: str
    msg: str


class PaginatedResponse(BaseModel):
    items: list[Any]
    total: int
    page: int
    per_page: int
    pages: int
