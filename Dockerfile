# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY .npmrc ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build React app
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
COPY .npmrc ./
RUN npm ci --only=production

# Copy built React app from builder
COPY --from=builder /app/dist ./dist

# Copy server files
COPY server.ts ./
COPY src ./src

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
