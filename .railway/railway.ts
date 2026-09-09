import {
  defineRailway,
  github,
  image,
  project,
  redis,
  service,
  volume,
} from "railway/iac";

const repository = "yukigesho/poidh-erpc-railway";

// This repository owns only the eRPC/monitoring stack, not the whole project.
// Keep this stable: Railway scopes this partial's ownership to its own resources.
export const partial = "erpc-monitoring";

export default defineRailway(() => {
  const cache = redis("redis");
  const prometheusData = volume("prometheus-data", { sizeMB: 1024 });
  const grafanaData = volume("grafana-data", { sizeMB: 512 });

  const erpc = service("erpc", {
    source: github(repository),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile.erpc",
    },
    env: {
      // Define these sealed values once as shared Railway variables.
      ERPC_AUTH_SECRET: "${{shared.ERPC_AUTH_SECRET}}",
      ALCHEMY_API_KEY: "${{shared.ALCHEMY_API_KEY}}",
      REDIS_URL: cache.env.REDIS_URL,
      GOMEMLIMIT: "460MiB",
    },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
  });

  const prometheus = service("prometheus", {
    source: github(repository),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile.prometheus",
    },
    healthcheck: "/-/ready",
    healthcheckTimeout: 120,
    env: {
      PORT: "9090",
      // Railway volumes are root-owned when first mounted.
      RAILWAY_RUN_UID: "0",
    },
    volumeMounts: {
      "/prometheus": prometheusData,
    },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
  });

  const grafana = service("grafana", {
    source: image("grafana/grafana:12.3.3"),
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    env: {
      PORT: "3000",
      // Grafana otherwise cannot write to its root-owned Railway volume.
      RAILWAY_RUN_UID: "0",
      GF_SERVER_HTTP_ADDR: "0.0.0.0",
      GF_SECURITY_ADMIN_USER: "admin",
      // Define this as an environment-level shared Railway variable before
      // applying; it is deliberately not stored in this repository.
      GF_SECURITY_ADMIN_PASSWORD: "${{shared.GRAFANA_ADMIN_PASSWORD}}",
    },
    volumeMounts: {
      "/var/lib/grafana": grafanaData,
    },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
  });

  return project("poidh-erpc", {
    resources: [cache, prometheusData, grafanaData, erpc, prometheus, grafana],
  });
});
