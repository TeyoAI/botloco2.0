import sys
from botapp import procesar_mensaje

def main():
    print("=========================================")
    print("   MODO DE PRUEBA LOCAL EN TERMINAL")
    print("=========================================")
    print("Escribe 'salir' para terminar el chat.")
    print("-----------------------------------------\n")
    
    numero_prueba = "000000000" # Número ficticio para la prueba
    
    while True:
        try:
            texto = input("Tú: ")
            if texto.lower() in ('salir', 'exit', 'quit', 'q'):
                print("Saliendo de la prueba...")
                break
            
            if not texto.strip():
                continue
                
            # Llamamos a la lógica interna del bot sin pasar por webhooks
            print("Escribiendo...")
            respuesta = procesar_mensaje(numero_prueba, texto)
            
            if respuesta:
                print(f"\nBot: {respuesta}\n")
            else:
                print("\nBot: [No dio ninguna respuesta]\n")
                
        except KeyboardInterrupt:
            print("\nSaliendo...")
            break
        except Exception as e:
            print(f"\nError: {e}\n")

if __name__ == "__main__":
    main()
