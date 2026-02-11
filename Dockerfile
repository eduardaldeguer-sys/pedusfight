# Usamos Node
FROM node:20-alpine

# Carpeta donde estará tu proyecto dentro del contenedor
WORKDIR /pedusfight

# Copiamos solo package.json e instalamos dependencias
COPY package.json ./
RUN npm install

# Copiamos todo el proyecto (incluyendo public)
COPY . .

# Exponemos el puerto que usa tu app
EXPOSE 3000

# Ejecutamos el servidor
CMD ["node", "server.js"]
