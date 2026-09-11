# Single self-contained image: the React client is built into the server's wwwroot and served by
# ASP.NET Core itself (Program.cs's UseStaticFiles + MapFallbackToFile), so there is no separate
# Node process at runtime and no reverse-proxy config needed beyond routing one port.
#
# The client build is driven by the csproj's BeforeTargets="Publish" target rather than by a
# separate stage here, so `docker build` and a plain `dotnet publish` produce the same thing - which
# means Node has to be present in the SDK stage.

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
ARG NODE_MAJOR=20

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Restore .NET and npm dependencies before copying the rest of the source, so an edit to a .cs or
# .jsx file doesn't invalidate either dependency layer.
COPY OptionAnalytics.Server/OptionAnalytics.Server.csproj OptionAnalytics.Server/
RUN dotnet restore OptionAnalytics.Server/OptionAnalytics.Server.csproj

COPY optionanalytics.client/package.json optionanalytics.client/package-lock.json* optionanalytics.client/
RUN cd optionanalytics.client && npm ci

COPY . .

# The publish target runs `npm install && npm run build` in optionanalytics.client and copies its
# dist/ into wwwroot - see the csproj. npm ci above means that install is a no-op cache hit.
RUN dotnet publish OptionAnalytics.Server/OptionAnalytics.Server.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime

# The aspnet runtime image ships no HTTP client at all, and the HEALTHCHECK below needs one to
# actually hit the app - without this it could only test that the dotnet binary exists, which tells
# you nothing about whether the app is serving.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/publish .

# Kestrel binds 8080 on all interfaces; Dokploy/Traefik routes to this from the outside.
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080

# Create and chown the data directory BEFORE declaring it a volume. Docker discards changes made
# to a volume path by instructions that come after its VOLUME declaration, so doing this the other
# way round leaves the directory root-owned, the non-root user below unable to write to it, and
# StrategyTriggerStore silently failing to save the very triggers the volume exists to keep.
RUN useradd -m -u 1001 optionanalytics \
 && mkdir -p /app/data \
 && chown -R optionanalytics:optionanalytics /app

# Armed strategy triggers are the ONLY thing this app persists - market data is all in memory and
# refetched from Dhan on every start. Point Storage__TriggersPath at this and mount it, or they are
# lost on every redeploy.
VOLUME ["/app/data"]

USER optionanalytics

# Dokploy/Traefik and `docker ps` both read this. /health is deliberately independent of Dhan: the
# feed is legitimately unauthenticated outside market hours or while a token renews, and a container
# killed for that would never finish starting. The generous start-period covers the first-run
# backfill (HistoryWindow.TradingDays trading days, 30 as of this writing, across ~68 option
# contracts), which takes minutes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["dotnet", "OptionAnalytics.Server.dll"]
