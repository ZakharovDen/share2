import { PrismaClient } from '@prisma/client'; // Замените на ваш импорт PrismaClient

function withTransactionClient(target: any) {
  const original = target.prototype;

  for (const key of Object.getOwnPropertyNames(original)) {
    const descriptor = Object.getOwnPropertyDescriptor(original, key);

    if (typeof descriptor?.value === 'function' && key !== 'constructor') {
      const originalMethod = descriptor.value;

      descriptor.value = function(...args: any[]) {
        // Ищем, есть ли в аргументах объект транзакции (обычно последний аргумент)
        let txArgIndex = -1;
        for (let i = args.length - 1; i >= 0; i--) {
          if (typeof args[i] === 'object' && args[i] !== null && typeof args[i].$transaction === 'function') {
            txArgIndex = i;
            break;
          }
        }

        //Если нашли аргумент транзакции, то используем его, иначе this.prisma
        const prismaClient = txArgIndex > -1 ? args[txArgIndex] : this.prisma;

        // Добавляем объявление переменной `tx` в начало тела метода
        const functionString = originalMethod.toString().replace(/^function.*?\(/, 'function(')
        const methodBody = functionString.slice(functionString.indexOf("{") + 1, functionString.lastIndexOf("}"));
        const txDeclaration = `const tx = ${txArgIndex > -1 ? 'prismaClient' : 'this.prisma'} as any;`;
        const newMethodBody = `${txDeclaration}\n${methodBody}`;

        // Создаем новую функцию, используя Function constructor
        const newFunction = new Function(...args.map((_, i) => `arg${i}`), newMethodBody);

        // Вызываем новую функцию с правильным контекстом и аргументами
        return originalMethod.apply(this, args);
      };

      Object.defineProperty(original, key, descriptor);
    }
  }

  return target;
}
