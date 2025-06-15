# Microservices Event Platform with Blockchain Integration

✨ A Node.js-based microservices application designed for event management, leveraging blockchain technology for enhanced security and transparency, IPFS for decentralized storage, Consul for service discovery, and Kong as an API Gateway.

---

## Table of Contents

- [Overview](#overview)
- [Services](#services)
- [Key Technologies](#key-technologies)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [Configuration](#configuration)
  - [Running the Application](#running-the-application)
- [Accessing Services](#accessing-services)
- [Project Structure (Simplified)](#project-structure-simplified)
- [Important Notes](#important-notes)

---

## Overview

This project implements a microservices architecture to build a robust and scalable platform, potentially for event ticketing or management. It integrates several modern technologies:

* **Node.js** for building the individual microservices.
* **Docker & Docker Compose** for containerization and orchestration.
* **Blockchain** for core functionalities (e.g., transaction recording, smart contracts - specific implementation details would be within `blockchain-service`).
* **IPFS (InterPlanetary File System)** for decentralized storage of assets.
* **Consul** for service discovery and health checking, ensuring services can find and communicate with each other reliably.
* **Kong API Gateway** as a single entry point for all client requests, handling routing, authentication (e.g., JWT), rate limiting, and more.

---

## Services

The platform is composed of the following services:

1.  **`consul`**:
    * **Image**: `hashicorp/consul:1.18`
    * **Description**: Handles service discovery and health monitoring. All other services depend on Consul being healthy.
    * **Ports**: `8500` (UI & HTTP API), `8600` (DNS TCP/UDP).
2.  **`ipfs-service`**:
    * **Description**: Manages interactions with the IPFS network for storing and retrieving files in a decentralized manner.
3.  **`blockchain-service`**:
    * **Description**: Interacts with the underlying blockchain (e.g., for smart contract execution, transaction processing).
4.  **`auth-service`**:
    * **Description**: Responsible for user authentication (e.g., login, registration) and authorization (issuing tokens like JWTs).
5.  **`user-service`**:
    * **Description**: Manages user profiles and related data.
6.  **`event-service`**:
    * **Description**: Handles the creation, management, and retrieval of event data. Depends on `ipfs-service` and `blockchain-service`.
7.  **`ticket-service`**:
    * **Description**: Manages ticket generation, sales, validation, and ownership. Depends on `event-service`, `ipfs-service`, and `blockchain-service`.
8.  **`seatmap-service`**:
    * **Description**: Manages seating arrangements and availability for events. Depends on `event-service`.
9.  **`kong-gateway-infra`**:
    * **Image**: `kong:3.7`
    * **Description**: The API Gateway that routes external requests to the appropriate internal microservices. It uses Consul for service discovery (`KONG_DNS_RESOLVER`).
    * **Ports**: `8000` (Proxy HTTP), `8443` (Proxy HTTPS), `8001` (Admin API).

---

## Key Technologies

* **Backend**: Node.js
* **Containerization**: Docker, Docker Compose
* **API Gateway**: Kong
* **Service Discovery**: HashiCorp Consul
* **Decentralized Storage**: IPFS
* **Blockchain**: (Specify the blockchain technology used, e.g., Ethereum, Hyperledger Fabric, etc., if known)
* **Communication**: Likely REST APIs and/or gRPC (Kong's `grpc-gateway` plugin is bundled, and a `protos` volume is mounted).

---

## Prerequisites

* [Docker](https://www.docker.com/get-started)
* [Docker Compose](https://docs.docker.com/compose/install/) (Usually included with Docker Desktop)
* Git (for cloning the repository)
* A code editor (e.g., VS Code)

---

## Getting Started

### Configuration

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd <your-repository-name>
    ```

2.  **Environment Variables (`.env` files):**
    Each microservice (e.g., `auth-service`, `user-service`, etc.) requires its own `.env` file for configuration. These are specified in the `docker-compose.yml` file (e.g., `./services/02-auth-service/.env`).
    * You will need to **create these `.env` files** in their respective service directories within the `services/` folder.
    * Populate them with the necessary environment variables. Look for `.env.example` files or consult the specific service's documentation if available.

3.  **Kong Configuration (`kong.yaml`):**
    The Kong API Gateway is configured declaratively using the `./kong_config/kong.yaml` file. Ensure this file is correctly set up with your desired routes, services, plugins (like JWT), consumers, etc.
    * The `KONG_JWT_SHARED_SECRET_VAR` environment variable in `docker-compose.yml` suggests that Kong's JWT plugin is intended to be used. Make sure the corresponding secret is defined in your environment or the `.env` file loaded by Docker Compose.

4.  **gRPC Protobufs (`protos/`):**
    If your services use gRPC, ensure your `.proto` definition files are placed in the `./protos` directory, as this is mounted into the Kong container. Kong's `grpc-gateway` plugin can transcode HTTP/JSON requests to gRPC.

### Running the Application

1.  **Start all services:**
    Open a terminal in the project's root directory (where `docker-compose.yml` is located) and run:
    ```bash
    docker-compose up -d
    ```
    The `-d` flag runs the containers in detached mode (in the background).

2.  **View logs:**
    To view the logs for all services:
    ```bash
    docker-compose logs -f
    ```
    To view logs for a specific service (e.g., `auth-service`):
    ```bash
    docker-compose logs -f auth-service
    ```

3.  **Stopping the application:**
    To stop and remove the containers, networks, and volumes created by `up`:
    ```bash
    docker-compose down
    ```
    To just stop the containers:
    ```bash
    docker-compose stop
    ```

---

## Accessing Services

* **API Gateway (Kong Proxy)**:
    * HTTP: `http://localhost:8000`
    * HTTPS: `https://localhost:8443` (if SSL is configured in `kong.yaml`)
* **Kong Admin API**: `http://localhost:8001`
* **Consul UI & API**: `http://localhost:8500`

Individual services are not directly exposed to the host machine by default (except Consul and Kong). They communicate with each other within the `microservices_network` Docker network using their service names and Consul for DNS resolution (e.g., `http://auth-service:port`).

---

## Important Notes

* **Service Dependencies**: The `depends_on` conditions in `docker-compose.yml` manage the startup order. Most services wait for Consul to be healthy, and services like `event-service` and `kong-gateway-infra` wait for their dependent services to be started.
* **DNS Resolution**: Services within the Docker network use Consul (`172.23.0.2:8600`) for DNS resolution to discover each other. This is configured in the `dns` section of each service and also for Kong via `KONG_DNS_RESOLVER`.
* **Health Checks**: Consul performs its own health check to determine if it's leading a cluster. Other services should ideally implement their own health check endpoints that Consul can query for robust health monitoring.
* **Environment Configuration**: **Crucially, ensure all `.env` files are correctly set up for each service.** Missing or incorrect configurations are common sources of errors.
* **Initial Startup**: On the first run, Docker will build the images for your services if they don't exist locally. This might take some time.

---

Happy Coding! 🚀
