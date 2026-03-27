"""
CCTV Local Service — Pydantic request/response models
"""
from pydantic import BaseModel, Field
from typing import Optional


class PlaybackStartRequest(BaseModel):
    rtspUrl: str = Field(..., min_length=10)
    sessionKey: str = Field(..., pattern=r'^[a-zA-Z0-9_\-]{1,128}$')


class PlaybackStartResponse(BaseModel):
    success: bool = True
    sessionKey: str
    hlsUrl: str


class PlaybackSeekRequest(BaseModel):
    sessionKey: str = Field(..., pattern=r'^[a-zA-Z0-9_\-]{1,128}$')
    rtspUrl: str = Field(..., min_length=10)
    offsetSeconds: float = Field(0, ge=0)


class PlaybackSeekResponse(BaseModel):
    success: bool = True
    sessionKey: str
    hlsUrl: str


class PlaybackStopRequest(BaseModel):
    sessionKey: str = Field(..., pattern=r'^[a-zA-Z0-9_\-]{1,128}$')


class PlaybackStopResponse(BaseModel):
    success: bool = True


class DownloadPrepareRequest(BaseModel):
    rtspUrl: str = Field(..., min_length=10)
    filename: Optional[str] = None


class DownloadPrepareResponse(BaseModel):
    success: bool = True
    token: str
    streamUrl: str


class HealthResponse(BaseModel):
    status: str = "ok"
    activeStreams: int = 0


class ErrorResponse(BaseModel):
    success: bool = False
    error: str
