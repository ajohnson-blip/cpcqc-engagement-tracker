"""Settings, all from the environment.

REDCap tokens are secrets and must come from the environment, never from a
file in the repository.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Shared secret the tracker presents as `Authorization: Bearer <token>`.
    # Rotate by setting a new value on both sides; no deploy needed here.
    auth_token: str = ""

    redcap_api_url: str = "https://redcap.vumc.org/api/"
    redcap_soar_token: str = ""
    redcap_spark_token: str = ""
    redcap_nest_token: str = ""
    redcap_ttt_hospital_token: str = ""
    redcap_ttt_patient_token: str = ""

    # Seconds. REDCap can be slow for a full program year.
    redcap_timeout: float = 90.0


settings = Settings()
