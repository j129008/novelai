from pydantic import BaseModel, Field
from typing import Literal, Optional

VALID_MODELS = Literal[
    "nai-diffusion-4-5-full",
]

VALID_SAMPLERS = Literal[
    "k_euler",
    "k_euler_ancestral",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m",
    "k_dpmpp_2m_sde",
    "k_dpmpp_sde",
]


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1)
    negative_prompt: str = ""
    model: VALID_MODELS = "nai-diffusion-4-5-full"
    width: int = Field(default=832, ge=64, le=2048)
    height: int = Field(default=1216, ge=64, le=2048)
    steps: int = Field(default=28, ge=1, le=50)
    scale: float = Field(default=5.0, ge=0, le=10)
    sampler: VALID_SAMPLERS = "k_euler_ancestral"
    seed: int = Field(default=0, ge=0)
    sm: bool = False
    sm_dyn: bool = False
    # img2img
    image: Optional[str] = None  # base64
    strength: float = Field(default=0.7, ge=0, le=1)
    noise: float = Field(default=0.0, ge=0, le=1)
    # vibe transfer
    reference_image: Optional[str] = None  # base64
    reference_information_extracted: float = Field(default=1.0, ge=0, le=1)
    reference_strength: float = Field(default=0.6, ge=0, le=1)


class GenerateResponse(BaseModel):
    image: str  # base64 encoded png
    seed: int
