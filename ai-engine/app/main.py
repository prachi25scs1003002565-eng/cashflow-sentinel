from fastapi import FastAPI, Depends, HTTPException, Security, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from app.config import settings
from app.schemas.forecast import ForecastRequest, ForecastResponse
from app.schemas.risk import RiskAnalysisRequest, RiskAnalysisResponse
from app.schemas.delay import PaymentDelayAnalysisRequest, PaymentDelayAnalysisResponse
from app.schemas.simulation import SimulationRequest, SimulationResponse
from app.schemas.health import HealthAssessmentRequest, HealthAssessmentResponse
from app.schemas.recommendation import (
    RecommendationCandidatesRequest,
    RecommendationCandidatesResponse,
)

from app.forecasting.engine import ForecastingEngine
from app.risk_analysis.engine import RiskAnalysisEngine
from app.payment_delay.engine import PaymentDelayEngine
from app.simulation.engine import SimulationEngine
from app.health.engine import FinancialHealthEngine
from app.recommendations.engine import RecommendationEngine

security = HTTPBearer()

def verify_service_token(credentials: HTTPAuthorizationCredentials = Security(security)):
    if credentials.credentials != settings.SERVICE_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid internal analytics service token",
        )
    return credentials.credentials

app = FastAPI(
    title="Cashflow Sentinel Private Analytics Engine",
    version=settings.SERVICE_VERSION,
    docs_url=None,   # Private service: disable Swagger UI in production
    redoc_url=None,
)

# Custom validation error handler
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    details = [
        {"field": ".".join(str(loc) for loc in err["loc"]), "issue": err["msg"]}
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": {
                "code": "INVALID_ANALYTICS_INPUT",
                "message": "The analytics request payload is invalid.",
                "details": details,
            },
            "request_id": request.headers.get("x-request-id", "req_unknown"),
        },
    )

# 1. Health check
@app.get("/internal/v1/health")
async def health_check():
    return {
        "status": "ok",
        "service": "cashflow-analytics",
        "version": settings.SERVICE_VERSION,
    }

# 2. Forecasting
@app.post(
    "/internal/v1/forecasts",
    response_model=ForecastResponse,
    dependencies=[Depends(verify_service_token)],
)
async def create_forecast(req: ForecastRequest):
    return ForecastingEngine.compute_forecast(req)

# 3. Risk Analysis
@app.post(
    "/internal/v1/risk-analysis",
    response_model=RiskAnalysisResponse,
    dependencies=[Depends(verify_service_token)],
)
async def analyze_risks(req: RiskAnalysisRequest):
    return RiskAnalysisEngine.analyze_risks(req)

# 4. Payment Delay Analysis
@app.post(
    "/internal/v1/payment-delay-analysis",
    response_model=PaymentDelayAnalysisResponse,
    dependencies=[Depends(verify_service_token)],
)
async def analyze_payment_delays(req: PaymentDelayAnalysisRequest):
    return PaymentDelayEngine.analyze_delays(req)

# 5. What-If Simulation
@app.post(
    "/internal/v1/simulations",
    response_model=SimulationResponse,
    dependencies=[Depends(verify_service_token)],
)
async def compute_simulation(req: SimulationRequest):
    return SimulationEngine.compute_simulation(req)

# 6. Financial Health Assessment
@app.post(
    "/internal/v1/financial-health",
    response_model=HealthAssessmentResponse,
    dependencies=[Depends(verify_service_token)],
)
async def assess_financial_health(req: HealthAssessmentRequest):
    return FinancialHealthEngine.assess_health(req)

# 7. Recommendation Candidates
@app.post(
    "/internal/v1/recommendation-candidates",
    response_model=RecommendationCandidatesResponse,
    dependencies=[Depends(verify_service_token)],
)
async def generate_recommendations(req: RecommendationCandidatesRequest):
    return RecommendationEngine.generate_candidates(req)
