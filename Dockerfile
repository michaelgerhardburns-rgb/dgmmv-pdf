FROM public.ecr.aws/lambda/nodejs:20

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

CMD ["index.handler"]
